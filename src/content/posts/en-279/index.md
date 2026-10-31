---
title: "Leveraging systemd Features to Build a Multi-tenant CodeServer"
published: 2026-06-06T07:34:00.000Z
updated: 2026-06-06T07:38:31.000Z
description: "Running per-user code-server instances on a server shared with friends, using systemd resource limits and password-file monitoring, with Python venvs and notes on isolation limits."
image: ""
tags: ["systemd", "codeserver"]
category: "Ops"
categories: ["Ops", "Cybersecurity"]
draft: false
lang: "en_US"
---

# Analysis

The motivation came from a university Python course: I wanted to use a tablet rather than bring my heavy laptop to every class. [coder/code-server: VS Code in the browser](https://github.com/coder/code-server) suited that use case. After I deployed it for myself, friends also wanted access. I considered containers, then chose a binary deployment with Linux users and venvs to manage each person's files and Python packages. I did not benchmark container performance against direct deployment.

The requirements are simple, roughly summarized as follows:
1. Each user can log into CodeServer using their own domain name.
2. Each user can change their own login password.
3. Each user has a separate Python package environment and can install pip packages independently.
4. Users should not be able to access each other's files.
5. Prevent users from accidentally deleting critical system components.
6. Prevent users from accidentally writing infinite loops or similar that exhaust server resources.
7. Prevent users from using the server for cryptocurrency mining or as a jump box for attacks.

After analysis and discussions with AI, the final solution is roughly as follows:
1. Run CodeServer under a separate Linux user and home directory, with ownership and permissions controlling file access. Home directories should be accessible only to their owners, for example with mode `0700`; creating separate users alone does not hide every file. Domain access also requires a separate reverse-proxy configuration.
2. Listening ports are calculated based on UID. Create a venv manually for each user and activate it automatically via `.bashrc` to satisfy requirement 3.
3. Use systemd to limit resource consumption and some process operations. This reduces the impact of mistakes but cannot prevent all mining or network abuse.
4. Use systemd's path mechanism to monitor `$HOME/.config/code-server/config.yaml` and automatically restart the daemon, allowing users to change their login password by modifying the configuration file – a relatively elegant way to achieve requirement 2.

~~For requirement 7, given the computer literacy level of first-year students, I'm not too worried (I hope?).~~  
I kept network access for package downloads and tasks such as web scraping. Ordinary IPv4/IPv6 outbound connections remain allowed, so these settings do not replace egress controls or abuse management.  
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
ReadWritePaths=/home/%i
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

`ProtectSystem=strict` also makes home directories read-only, so `ReadWritePaths=/home/%i` explicitly allows writes to this user's working directory. It does not grant additional filesystem permissions; ownership and permissions still need to be set correctly. A venv separates Python packages, but is not a security sandbox restricting access to the host or other files.

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
    - **Effect:** Sets a 1 GiB memory limit for the service's cgroup.
    - **Outcome:** If the service cgroup reaches its limit and memory reclaim cannot relieve the pressure, an OOM kill may occur within the group. Here, `1G` means 1 GiB.
- **`CPUQuota=150%`**
    - **Effect:** Limits the service to at most 150% CPU usage.
    - **Outcome:** 100% represents one full CPU core. 150% means the service can saturate one core and use half of a second core (i.e., up to 1.5 CPU cores' worth of compute).
- **`TasksMax=200`**
    - **Effect:** Limits the service to a maximum of 200 tasks (processes or threads).
    - **Outcome:** Prevents the service from creating unlimited child processes due to bugs or infinite loops (e.g., fork bomb), which could exhaust system PID resources and crash the system.
- **`IOWeight=50`**
    - **Effect:** Sets the disk I/O priority weight. The default is usually 100.
    - **Outcome:** Where the device and I/O controller support weighted scheduling, 50 reduces the service's relative share under contention. It is not a fixed throughput limit or a guarantee that other services remain unaffected.

### II. Security & Isolation
These settings restrict access to filesystems, devices, and sockets to reduce the impact of mistakes and limit some attack paths.
- **`ProtectSystem=strict`**
    - **Effect:** Strictly protects system files.
    - **Outcome:** Makes the filesystem hierarchy read-only, except for API filesystems and explicitly writable paths. Here, `ReadWritePaths` keeps the user's home writable. This mount restriction does not replace kernel security updates.
- **`PrivateTmp=yes`**
    - **Effect:** Provides an independent temporary directory for the service.
    - **Outcome:** The service sees its own private `/tmp` and `/var/tmp` directories. It cannot see or modify files placed in the global `/tmp` by other users/services, and vice versa. This effectively prevents symlink attacks or data leaks based on temporary files.
- **`PrivateDevices=yes`**
    - **Effect:** Isolates physical devices.
    - **Outcome:** Provides a private `/dev` with necessary pseudo-devices such as `/dev/null`, `/dev/zero`, and `/dev/urandom`, restricting direct access to host device nodes. This does not isolate every possible route to hardware access.
- **`NoNewPrivileges=yes`**
    - **Effect:** Restricts acquiring additional privileges by executing another program.
    - **Outcome:** The service and its descendants cannot gain privileges through setuid/setgid bits or file capabilities during `execve()`. It does not prevent every escalation path, such as a kernel exploit that directly changes process credentials.
- **`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`**
    - **Effect:** Restricts the socket address families the service can use.
    - **Outcome:** Allows creating sockets in these address families:
        - `AF_INET`: IPv4 network communication
        - `AF_INET6`: IPv6 network communication
        - `AF_UNIX`: local UNIX domain sockets (for local IPC)
    - On systems supporting the relevant seccomp filtering, calls to create sockets in other address families are restricted. This reduces attack surface but does not restrict IPv4/IPv6 destinations or revoke sockets inherited or passed to the service.

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

I set this up before CopyFail and DirtyFrag were disclosed. After disclosure, I ran the PoCs available to me under this configuration and did not observe successful privilege escalation. That observation applies to the environment and samples I tested, not every related exploit variant.

The tested exploit paths needed sockets such as `AF_ALG`, or `AF_NETLINK` and `AF_RXRPC`, which this `RestrictAddressFamilies` allowlist excludes. It may therefore block those paths at socket creation. Establishing the exact failure point requires the specific PoC, kernel version, and system logs.

`NoNewPrivileges=yes` restricts another path: the service and its descendants cannot gain privileges through setuid/setgid bits or file capabilities during `execve()`. It does not prevent all privilege changes outside `execve()`, nor ensure that damaged system files cannot affect other privileged processes. System updates remain necessary; these settings do not replace vulnerability fixes.

This article does not explore SELinux. The setup is intended for a server shared with friends rather than critical production workloads. These systemd options combine namespaces, cgroups, and seccomp, but do not form a complete tenant security boundary. SELinux/AppArmor can further restrict access, but cannot guarantee protection against every kernel vulnerability either. Mutually untrusted users call for an assessment of stronger isolation based on the threat model.

Of course, this solution has other limitations. For example, when there are many users or special UID allocation requirements that exceed 10000, the port calculation logic may fail. For legitimate needs like scientific computing, the current restrictions may be too strict. This article is only intended as a discussion and reference.

_Random thoughts: In the age of containerization and cloud-native, traditional systemd still has many interesting features worth exploring that can accomplish a lot…_

---
Reference:
1. [systemd.git - A fork of systemd to make components more independant](https://git.parabola.nu/~lukeshu/systemd.git/log/man?id=6b3d378331fe714c7bf2263eaa9a8b33fc878e7c&ofs=200&showmsg=1)
2. [systemd.exec: Execution Environment and Sandboxing Options](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
3. [Linux Kernel Documentation: No New Privileges Flag](https://docs.kernel.org/userspace-api/no_new_privs.html)
