---
title: "Leveraging systemd Features to Build a Multi-tenant CodeServer"
published: 2026-06-06T07:34:00.000Z
updated: 2026-06-06T07:38:31.000Z
description: "This article details how to leverage systemd features (resource limits, sandboxing, Path units) to build a multi-tenant CodeServer environment, enabling isolated per-user execution, self-service password changes, isolated Python virtual environments, and incidentally blocking kernel exploits like CopyFail and DirtyFrag. Ideal for administrators who want to securely provide browser-based VS Code to multiple users on a Linux server."
image: ""
tags: ["systemd", "codeserver"]
category: "Ops"
draft: false
lang: "en_US"
---

# Analysis

The motivation came from a university Python course – I didn't want to bring my heavy laptop to every class, so I tried to see if a tablet could do the job. After some searching, I found [coder/code-server: VS Code in the browser](https://github.com/coder/code-server) which fit the requirements perfectly while also being cross-platform. I deployed it for myself, but later my friends also wanted access. That got me thinking about how to support multi-tenancy and security simultaneously. Initially I considered containerization, but because of the need to install new pip packages, containers would have been tricky – I would have had to persist Python site-packages and everything, and performance would suffer. So I decided to stick with a binary deployment.

The requirements are simple, roughly summarized as follows:
1. Each user can log into CodeServer using their own domain name.
2. Each user can change their own login password.
3. Each user's Python environment is completely isolated and can independently install pip packages.
4. Users should not be able to access each other's files.
5. Prevent users from accidentally deleting critical system components.
6. Prevent users from accidentally writing infinite loops or similar that exhaust server resources.
7. Prevent users from using the server for cryptocurrency mining or as a jump box for attacks.

After analysis and discussions with AI, the final solution is roughly as follows:
1. Use Linux's native multi-user mechanism – each user runs a CodeServer under their own home directory for basic isolation. This easily satisfies requirements 1, 4 and 5.
2. Listening ports are calculated based on UID. Create a venv manually for each user and activate it automatically via `.bashrc` to satisfy requirement 3.
3. Use systemd's restrictions to limit process behavior, achieving requirements 6–7 to a certain extent.
4. Use systemd's path mechanism to monitor `$HOME/.config/code-server/config.yaml` and automatically restart the daemon, allowing users to change their login password by modifying the configuration file – a relatively elegant way to achieve requirement 2.

~~For requirement 7, given the computer literacy level of first-year students, I'm not too worried (I hope?).~~  
I didn't cut off network access completely because some requirements need internet to download packages, or might involve web scraping. systemd's restrictions should already block most malicious operations.  
This article does not cover SELinux, because in my opinion SELinux would be over-engineering for these requirements, and I'm not very familiar with SELinux/SEPolicy (that's the main reason lol). I also wanted to avoid imposing restrictions that hinder legitimate usage, so SELinux is not used.

# Deployment

## Configuring systemd
Download the CodeServer binary and upload it to the server – for example, I put it at `/usr/bin/code-server`. Then write the systemd service file, create `/etc/systemd/system/code-server@.service`:

```toml
# /etc/systemd/system/code-server@.service
[Unit]
Description=Code-Server for %i
After=network.target

[Service]
Type=simple
User=%i
Group=%i
WorkingDirectory=/home/%i
MemoryMax=1G
CPUQuota=150%
TasksMax=200
IOWeight=50
ProtectSystem=strict
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# ExecStart=/bin/bash -c "PASSWORD=$(echo -n "%i" | md5sum | cut -d' ' -f1) /usr/bin/code-server --bind-addr 0.0.0.0:$((7000 + $(id -u %i))) --auth password"
ExecStart=/bin/bash -c ' \
    PORT=$((7000 + $(id -u %i) %% 10000)); \
    /usr/bin/code-server --bind-addr 0.0.0.0:$PORT; \
    '
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

The filename is `code-server@.service`; the part after `@` is substituted for `%i`. The design passes the username via `%i`, calculates the port, and starts automatically. The port calculation logic is `7000+uid%10000`. Typically UIDs start from 1000, so ports start from 8000 in order of user creation.

Note this part of the configuration:
```toml
MemoryMax=1G
CPUQuota=150%
TasksMax=200
IOWeight=50
ProtectSystem=strict
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
```
(I'll let AI explain it)
It mainly covers two aspects: **Resource Control** and **Security & Sandboxing**.

### I. Resource Control
This uses Linux's cgroups mechanism to prevent the service from consuming excessive system resources and affecting other programs.
- **`MemoryMax=1G`**
    - **Effect:** Limits the service to a maximum of 1GB of memory.
    - **Outcome:** If the service tries to use more than 1GB, the system (OOM Killer) will forcibly kill the process to protect the system.
- **`CPUQuota=150%`**
    - **Effect:** Limits the service to at most 150% CPU usage.
    - **Outcome:** 100% represents one full CPU core. 150% means the service can saturate one core and use half of a second core (i.e., up to 1.5 CPU cores' worth of compute).
- **`TasksMax=200`**
    - **Effect:** Limits the service to a maximum of 200 tasks (processes or threads).
    - **Outcome:** Prevents the service from creating unlimited child processes due to bugs or infinite loops (e.g., fork bomb), which could exhaust system PID resources and crash the system.
- **`IOWeight=50`**
    - **Effect:** Sets the disk I/O priority weight. The default is usually 100.
    - **Outcome:** A value of 50 means when system I/O is busy, this service gets lower priority for disk read/write resources compared to default services, preventing it from choking the whole system when doing heavy file I/O.

### II. Security & Isolation
This uses Linux namespaces and other kernel security mechanisms to "cage" the service, minimizing damage even if the service is compromised.
- **`ProtectSystem=strict`**
    - **Effect:** Strictly protects system files.
    - **Outcome:** The entire operating system's filesystem (the root `/` and everything under it, except special API directories like `/dev`, `/proc`, `/sys`) is made **read-only** for this service. The service cannot modify, overwrite, or delete any critical system files.
- **`PrivateTmp=yes`**
    - **Effect:** Provides an independent temporary directory for the service.
    - **Outcome:** The service sees its own private `/tmp` and `/var/tmp` directories. It cannot see or modify files placed in the global `/tmp` by other users/services, and vice versa. This effectively prevents symlink attacks or data leaks based on temporary files.
- **`PrivateDevices=yes`**
    - **Effect:** Isolates physical devices.
    - **Outcome:** Mounts a private `/dev` directory for the service, containing only pseudo-devices (e.g., `/dev/null`, `/dev/zero`, `/dev/urandom`). The service **cannot see** real physical hardware devices (like `/dev/sda`, USB devices), completely eliminating the possibility of directly reading/writing block devices.
- **`NoNewPrivileges=yes`**
    - **Effect:** Prevents privilege escalation.
    - **Outcome:** Ensures that the service and all its child processes, no matter what, cannot gain new system privileges. Even if the service invokes a program with the SUID bit (e.g., `sudo` or `su`), it cannot escalate to root privileges.
- **`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`**
    - **Effect:** Restricts the socket address families the service can use.
    - **Outcome:** The service can only use:
        - `AF_INET`: IPv4 network communication
        - `AF_INET6`: IPv6 network communication
        - `AF_UNIX`: local UNIX domain sockets (for local IPC)
    - Any other address families (e.g., low-level packet capture `AF_PACKET`, Bluetooth `AF_BLUETOOTH`, etc.) are blocked by the kernel. This greatly reduces the network attack surface.

When creating a new user, just run:
```shell
adduser <username>
systemctl enable --now code-server@<username>
```
to simultaneously create the corresponding CodeServer service.

## Configuring password change auto-restart

Create `/etc/systemd/system/code-server-restart@.path`:
```toml
# /etc/systemd/system/code-server-restart@.path
[Unit]
Description=Monitor code-server config change for %i
After=network.target

[Path]
PathChanged=/home/%i/.config/code-server/config.yaml

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/code-server-restart@.service`:
```toml
[Unit]
Description=Triggered safe restart for %i

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/bin/safe-restart-codeserver.sh %i

[Install]
WantedBy=multi-user.target
```

The logic works like this:

### Step 1: Start monitoring (handled by the `.path` file)
1. The system or administrator starts `code-server-restart@yms.path`.
2. systemd parses the `.path` file, replacing `%i` with `yms`.
3. **`PathChanged=/home/yms/.config/code-server/config.yaml`**: systemd starts quietly listening (using the inotify mechanism) for changes to this specific `config.yaml` file at the kernel level.

### Step 2: Detect change and trigger
1. The user modifies settings in the CodeServer web interface, or edits `config.yaml` via the command line and saves.
2. `PathChanged` detects that the file has been modified **and closed** (ensuring the write is complete and avoiding reading half-written dirty data).
3. **Implicit binding:** Because the `.path` file does not explicitly specify a service to trigger using `Unit=`, systemd's default behavior is to trigger **the `.service` file with the same name (without the suffix)**.
4. systemd then automatically starts `code-server-restart@yms.service`.

### Step 3: Execute the action (handled by the `.service` file)
1. systemd executes `code-server-restart@yms.service`. Again, `%i` is replaced with `yms`.
2. **`Type=oneshot`**: Tells the system this is not a long-running daemon but a one-shot task. It exits when done.
3. **`User=root`**: The restart operation requires higher privileges, so it's forced to run as `root`.
4. **`ExecStart=/usr/local/bin/safe-restart-codeserver.sh <user>`**: This is the final step in the logic. The system runs the custom shell script as root, passing the username as an argument.

We don't restart the main daemon directly inside the restart service because CodeServer auto-saves on every edit. There's a risk that during password changes, a half-edited file might trigger a restart, causing incomplete writes. So we write a script that waits until the file is stable before triggering the restart:

`/usr/local/bin/safe-restart-codeserver.sh`
```shell
#!/bin/bash
USER_NAME=$1
CONFIG_FILE="/home/$USER_NAME/.config/code-server/config.yaml"
STAMP_FILE="/tmp/code-server-restart-${USER_NAME}.stamp"

# 1. Intercept: if stamp file exists and config file is older (or same age) than stamp,
#    this trigger is a leftover queued event from systemd – exit
if [ -f "$STAMP_FILE" ] && [ "$CONFIG_FILE" -ot "$STAMP_FILE" ]; then
    echo "Config hasn't changed since last restart, exiting."
    exit 0
fi

# 2. Debounce wait logic (unchanged)
while true; do
    last_md5=$(md5sum "$CONFIG_FILE")
    sleep 5
    current_md5=$(md5sum "$CONFIG_FILE")
    
    if [ "$last_md5" == "$current_md5" ]; then
        # File is stable, perform restart
        systemctl restart code-server@$USER_NAME
        
        # 3. After successful restart, update the stamp file's mtime
        touch "$STAMP_FILE"
        break
    else
        echo "Config file for $USER_NAME is still changing, waiting..."
    fi
done
```

The timestamp mechanism prevents multiple pointless restarts. If the config file's last edit time is earlier than the last restart time, the restart is rejected.

After writing the files, enable the trigger: `systemctl enable --now code-server-restart@<username>.path` (note it's `.path`, not `.service`). Then try slowly editing the password in the config file via the web interface, and check the logs for something like:

```plain
○ code-server-restart@lyr.service - Triggered safe restart for lyr
     Loaded: loaded (/etc/systemd/system/code-server-restart@.service; disabled; preset: enabled)
     Active: inactive (dead) since Sat 2026-06-06 06:43:55 UTC; 29s ago
 Invocation: 0bd37fcb6ea44a58870c06b4fde5300c
TriggeredBy: ● code-server-restart@lyr.path
    Process: 6997 ExecStart=/usr/local/bin/safe-restart-codeserver.sh lyr (code=exited, status=0/SUCCESS)
   Main PID: 6997 (code=exited, status=0/SUCCESS)
   Mem peak: 2.5M
        CPU: 43ms

Jun 06 06:43:40 CodeServer systemd[1]: Starting code-server-restart@lyr.service - Triggered safe restart for lyr...
Jun 06 06:43:45 CodeServer safe-restart-codeserver.sh[6997]: Config file for lyr is still changing, waiting...
Jun 06 06:43:50 CodeServer safe-restart-codeserver.sh[6997]: Config file for lyr is still changing, waiting...
Jun 06 06:43:55 CodeServer systemd[1]: code-server-restart@lyr.service: Deactivated successfully.
Jun 06 06:43:55 CodeServer systemd[1]: Finished code-server-restart@lyr.service - Triggered safe restart for lyr.
```

After editing stops for 5 seconds, CodeServer will restart, and the new password can be used to log in.

## Configuring Python venv

First, install Python3 on the system (no need to elaborate – use the package manager). Also install `python3-venv`:
```shell
apt install python3-venv
```

Then, enter the user's home directory. I chose to create a folder named `.venv` for the virtual environment. Inside `.venv`, run `python3 -m venv myvenv` to create a virtual environment named `myvenv`, and append the following line to the user's `.bashrc`:
```diff
  fi
fi

+source ~/.venv/myvenv/bin/activate
```

After that, the venv is automatically activated when the shell starts.

## Installing the Python extension in CodeServer and pointing it to the venv

I won't go into detail here – just install the Python and debugger extensions in the CodeServer web interface, and set the Python interpreter to the one under the venv.

---

# Postscript

I actually set this up a long time ago but never wrote about it. At that time, vulnerabilities like CopyFail and DirtyFrag hadn't been disclosed yet. When they were disclosed, I tested them immediately and found that this systemd configuration happened to block them all. A rough analysis follows:

CopyFail uses a special socket type: `AF_ALG`. Our systemd configuration only allows `AF_INET AF_INET6 AF_UNIX`, so CopyFail cannot escalate privileges. Similarly for DirtyFrag – it uses `AF_NETLINK`, `AF_RXRPC`, and `AF_ALG`, all of which are blocked.  
Also, `NoNewPrivileges=yes` acts as a final line of defense. The ultimate goal of those exploits is to tamper with `/usr/bin/su` to inject malicious ELF shellcode, or modify `/etc/passwd` to clear the root password, then invoke the setuid `su` command to gain root privileges. With `NoNewPrivileges` set, the process and all its descendants can **absolutely never** gain higher privileges through the `setuid` or `setgid` flags of any file. Even if a future vulnerability finds a way to bypass the network restrictions and successfully replace `/usr/bin/su` with a malicious shell, executing `su` would still spawn a low-privilege shell – privilege escalation becomes impossible.

This article does not cover SELinux, because the current solution is acceptably simplified for the scenario of "friends sharing, non-production critical", avoiding the risk of misconfiguration causing functional issues and operational complexity. In reality, systemd's sandboxing options are primarily based on namespaces and cgroups, and cannot fully replace mandatory access control (like SELinux or AppArmor). For higher security requirements for tenant isolation (e.g., preventing kernel escape vulnerabilities among untrusted users), SELinux/AppArmor is still the mainstream choice.

Of course, this solution has other limitations. For example, when there are many users or special UID allocation requirements that exceed 10000, the port calculation logic may fail. For legitimate needs like scientific computing, the current restrictions may be too strict. This article is only intended as a discussion and reference.

_Random thoughts: In the age of containerization and cloud-native, traditional systemd still has many interesting features worth exploring that can accomplish a lot…_

---
Reference:
1. [systemd.git - A fork of systemd to make components more independant](https://git.parabola.nu/~lukeshu/systemd.git/log/man?id=6b3d378331fe714c7bf2263eaa9a8b33fc878e7c&ofs=200&showmsg=1)
