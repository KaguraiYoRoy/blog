---
title: "An Experience of Manually Installing Proxmox VE, Configuring Multipath iSCSI, and NAT Forwarding"
published: 2025-11-29T09:39:00.000Z
updated: 2025-12-14T13:25:54.000Z
description: "A detailed guide on manually installing Proxmox VE on Debian 13, configuring multipath iSCSI storage for data disks, and setting up NAT forwarding & port forwarding for VMs using a single public IP.\r\n"
image: ""
tags: ["Network Technology", "iSCSI", "PVE"]
category: "Ops"
categories: ["Ops", "Network"]
draft: false
lang: "en_US"
---

The reason was that I rented a physical server, but the IDC did not provide Proxmox VE or Debian system images, only Ubuntu, CentOS, and Windows series. Additionally, the data disk was provided via multipath iSCSI. I wanted to use PVE for isolating different usage scenarios, so I attempted to reinstall the system and migrate the aforementioned configurations.

# Backup Configuration
First, perform a general check of the system, which reveals:
1. The system has two Network Interfaces: `enp24s0f0` is connected to a public IP address for external access; `enp24s0f1` is connected to the private network address `192.168.128.153`.
2. The data disk is mapped to `/dev/mapper/mpatha`.
3. Under `/etc/iscsi`, there are configurations for two iSCSI Nodes: `192.168.128.250:3260` and `192.168.128.252:3260`, both corresponding to the same target `iqn.2024-12.com.ceph:iscsi`.
It can be inferred that the data disk is mounted by configuring two iSCSI Nodes and then merging them into a single device using multipath.

Check the system's network configuration:
```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    enp24s0f0:
      addresses: [211.154.[REDACTED]/24]
      routes:
        - to: default
          via: [REDACTED]
      match:
          macaddress: ac:1f:6b:0b:e2:d4
      set-name: enp24s0f0
      nameservers:
        addresses:
          - 114.114.114.114
          - 8.8.8.8
    enp24s0f1:
      addresses:
        - 192.168.128.153/17
      match:
        macaddress: ac:1f:6b:0b:e2:d5
      set-name: enp24s0f1
```

It's found to be very simple static routing. The internal network interface doesn't even have a default route; just binding the IP is sufficient.

Then, save the iSCSI configuration files from `/etc/iscsi`, which include account and password information.

# Reinstall Debian
Used the [bin456789/reinstall](https://github.com/bin456789/reinstall) script for this reinstallation.
Download the script:
```shell
curl -O https://cnb.cool/bin456789/reinstall/-/git/raw/main/reinstall.sh || wget -O ${_##*/} $_
```

Reinstall as Debian 13 (Trixie):
```shell
bash reinstall.sh debian 13
```
Then, enter the password you want to set as prompted.

If all goes well, wait about 10 minutes, and it will automatically complete and reinstall into a clean Debian 13. You can connect via SSH during the process using the set password to check the installation progress.

After reinstalling, perform a source change and `apt upgrade` as usual to get a clean Debian 13.
For changing sources, directly refer to the [USTC Mirror Site tutorial](https://mirrors.ustc.edu.cn/help/debian.html).

# Install Proxmox VE
This step mainly refers to the Proxmox official [tutorial](https://pve.proxmox.com/wiki/Install_Proxmox_VE_on_Debian_12_Bookworm).

Note: The Debian installed by the above script sets the hostname to `localhost`. If you want to change it, please modify it **before configuring the Hostname** and change the hostname in hosts to your modified hostname, not `localhost`.

## Configure Hostname
Proxmox VE requires the current hostname to be resolvable to a non-loopback IP address:

> The hostname of your machine must be resolvable to an IP address. This IP address must not be a loopback one like `127.0.0.1` but one that you and other hosts can connect to.

For example, my server IP is `211.154.[CENSORED]`, I need to add the following record in `/etc/hosts`:
```diff
127.0.0.1       localhost
+211.154.[CENSORED] localhost
::1             localhost ip6-localhost ip6-loopback
ff02::1         ip6-allnodes
ff02::2         ip6-allrouters
```

After saving, use `hostname --ip-address` to check if it outputs the set non-loopback address: `::1 127.0.0.1 211.154.[CENSORED]`.

## Add Proxmox VE Software Repository
Debian 13 uses the Deb822 format ~~(though you can use sources.list if you want)~~, so just refer to the [USTC Proxmox Mirror Site](https://mirrors.ustc.edu.cn/help/proxmox.html):
```shell
cat > /etc/apt/sources.list.d/pve-no-subscription.sources <<EOF
Types: deb
URIs: https://mirrors.ustc.edu.cn/proxmox/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
```

Here, a keyring needs to be migrated ~~but I couldn't find one after searching online~~, so I chose to pull a copy from an existing Proxmox VE server. It's available here: [proxmox-keyrings.zip](/downloads/2025/11/4102711242.zip)
Extract the public key file and place it in `/usr/share/keyrings/`, then run:
```shell
apt update
apt upgrade -y
```
This will sync the Proxmox VE software repository.

## Install Proxmox VE Kernel
Use the following command to install the PVE kernel and reboot to apply the new kernel:
```shell
apt install proxmox-default-kernel
reboot
```
Afterwards, `uname -r` should show a kernel version ending with `pve`, like `6.17.2-2-pve`, indicating the new kernel is successfully applied.

## Install Proxmox VE Related Packages
Use apt to install the corresponding packages:
```shell
apt install proxmox-ve postfix open-iscsi chrony
```
During configuration, you will need to set up the `postfix` mail server. Official explanation:
> If you have a mail server in your network, you should configure postfix as a **satellite system**. Your existing mail server will then be the relay host which will route the emails sent by Proxmox VE to their final recipient.  
If you don't know what to enter here, choose **local only** and leave the _system name_ as is.

After this, you should be able to access the Web console at `https://<your server address>:8006`. The account is `root`, and the password is your root password, i.e., the password configured during the Debian reinstallation.

## Remove Old Debian Kernel and `os-prober`
Use the following commands:
```shell
apt remove linux-image-amd64 'linux-image-6.1*'
update-grub
apt remove os-prober
```
to remove the old Debian kernel, update grub, and remove `os-prober`. Removing `os-prober` is not mandatory, but it is recommended by the official guide because it might mistakenly identify VM boot files as multi-boot files, adding incorrect entries to the boot list.

At this point, the installation of Proxmox VE is complete and ready for normal use!

# Configuring Internal Network Interface
Because the iSCSI network interface and the public network interface are different, and the reinstallation lost this configuration, the internal network interface needs to be manually configured.
Open the Proxmox VE Web interface, go to **Datacenter** - **localhost** (hostname) - **Network**, edit the internal network interface (e.g., `ens6f1` here), enter the backed-up IPv4 in CIDR format: `192.168.128.153/17`, and check **Autostart**, then save.
Then use the command to set the interface state to UP:
```shell
ip link set ens6f1 up
```
Now you should be able to ping the internal iSCSI server's IP.

# Configure Data Disk
## iSCSI
In the previous step, we should have installed the `open-iscsi` package required for `iscsiadm`. We just need to reset the nodes according to the backed-up configuration.

First, discover the iSCSI storage:
```shell
iscsiadm -m discovery -t st -p 192.168.128.250:3260
```
This should yield the two original LUN Targets:
```txt
192.168.128.250:3260,1 iqn.2024-12.com.ceph:iscsi
192.168.128.252:3260,2 iqn.2024-12.com.ceph:iscsi
```

Transfer the backed-up configuration files to the server, overwriting the existing configuration in `/etc/iscsi`. Also, in my backed-up config, I found the authentication configuration:
```ini
# /etc/iscsi/nodes/iqn.2024-12.com.ceph:iscsi/192.168.128.250,3260,1/default
# BEGIN RECORD 2.1.5
node.name = iqn.2024-12.com.ceph:iscsi
... # Some unimportant configurations omitted
node.session.auth.authmethod = CHAP
node.session.auth.username = [CENSORED]
node.session.auth.password = [CENSORED]
node.session.auth.chap_algs = MD5
... # Some unimportant configurations omitted
```
```ini
# /etc/iscsi/nodes/iqn.2024-12.com.ceph:iscsi/192.168.128.252,3260,2/default
# BEGIN RECORD 2.1.5
node.name = iqn.2024-12.com.ceph:iscsi
... # Some unimportant configurations omitted
node.session.auth.authmethod = CHAP
node.session.auth.username = [CENSORED]
node.session.auth.password = [CENSORED]
node.session.auth.chap_algs = MD5
... # Some unimportant configurations omitted
```
Write these configurations to the new system using:
```shell
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.authmethod -v CHAP
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.username -v [CENSORED]
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.password -v [CENSORED]
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.chap_algs -v MD5

iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 -o update -n node.session.auth.authmethod -v CHAP
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 -o update -n node.session.auth.username -v [CENSORED]
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 -o update -n node.session.auth.password -v [CENSORED]
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.chap_algs -v MD5
```
(I don't know why the auth info needs to be written separately, but testing shows it won't log in without rewriting it.)

Then, use:
```shell
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 --login
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 --login
```
to log into the Targets. Then use:
```shell
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.startup -v automatic
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 -o update -n node.startup -v automatic
```
to enable automatic mounting on boot.

At this point, checking disks with tools like `lsblk` should reveal two additional hard drives; in my case, `sdb` and `sdc` appeared.

## Configure Multipath
To identify if it's a multipath device, I tried:
```shell
/usr/lib/udev/scsi_id --whitelisted --device=/dev/sdb
/usr/lib/udev/scsi_id --whitelisted --device=/dev/sdc
```
Checking the `scsi_id` of the two disk devices revealed they were identical, confirming they are the same disk using multi-path for load balancing and failover.

Install `multipath-tools` using apt:
```shell
apt install multipath-tools
```
Then, create `/etc/multipath.conf` and add:
```nginx
defaults {
    user_friendly_names yes
    find_multipaths yes
}
```

Configure `multipathd` to start on boot:
```shell
systemctl start multipathd
systemctl enable multipathd
```

Then, use the following command to scan and automatically configure the multipath device:
```shell
multipath -ll
```
It should output:
```txt
mpatha(360014056229953ef442476e85501bfd7)dm-0LIO-ORG,TCMU device
size=500G features='1 queue_if_no_path' hwhandler='1 alua'wp=rw
|-+- policy='service-time 0' prio=50 status=active
| `- 14:0:0:152 sdb 8:16 active ready running
`-+- policy='service-time 0' prio=50 status=active
  `- 14:0:0:152 sdc 8:16 active ready running
```
This shows the two disks have been recognized as a single multipath device. Now, you can find the multipath disk under `/dev/mapper/`:
```shell
root@localhost:/dev/mapper# ls
control  mpatha
```
`mpatha` is the multipath aggregated disk.

If it's not scanned, try using:
```shell
rescan-scsi-bus.sh
```
to rescan the SCSI bus and try again. If the command is not found, install it via `apt install sg3-utils`.
~~If all else fails, just reboot.~~

## Configure Proxmox VE to Use the Data Disk
Because we used multipath, we cannot directly add an iSCSI type storage.
Use the following commands to create the PV and VG:
```shell
pvcreate /dev/mapper/mpatha
vgcreate <vg name> /dev/mapper/mpatha
```
Here, I configured the entire disk as a PV. You could also create a separate partition for this.

After completion, open the Proxmox VE management interface, go to **Datacenter** - **Storage**, click **Add** - **LVM**, select the name of the VG you just created for **Volume group**, give it an **ID** (name), and click **Add**.

At this point, all configurations from the original system should have been migrated.

# Configure NAT and Port Forwarding
## NAT
Because only one IPv4 address was purchased, NAT needs to be configured to allow all VMs to access the internet normally.
Open `/etc/network/interfaces` and add the following content:
```txt
auto vmbr0
iface vmbr0 inet static
    address   192.168.100.1
    netmask   255.255.255.0
    bridge_ports none
    bridge_stp off
    bridge_fd 0

    post-up   echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up   iptables -t nat -A POSTROUTING -s 192.168.100.0/24 -o ens6f0 -j MASQUERADE
    post-up   iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1
    post-up   iptables -A FORWARD -i vmbr0 -j ACCEPT
    post-down iptables -t nat -D POSTROUTING -s 192.168.100.0/24 -o ens6f0 -j MASQUERADE
    post-down iptables -t raw -D PREROUTING -i fwbr+ -j CT --zone 1
    post-down iptables -D FORWARD -i vmbr0 -j ACCEPT
```
Here, `vmbr0` is the NAT bridge, with the IP segment `192.168.100.0/24`. Traffic from this segment will be translated to the IP of the external network interface `ens6f0` for outgoing traffic, and translated back to the original IP upon receiving replies, enabling IP sharing.

Then, use:
```shell
ifreload -a
```
to reload the configuration.

Now, the VMs should be able to access the internet. Just configure a static IP within the `192.168.100.0/24` range during installation, set the default gateway to `192.168.100.1`, and configure the DNS address.

## Port Forwarding
~~Got lazy, directly prompted an AI.~~

Had an AI write a configuration script `/usr/local/bin/natmgr`:
```shell
#!/bin/bash

# =================Configuration Area=================
# Public network interface name (Please modify according to your actual situation)
PUB_IF="ens6f0"
# ====================================================

ACTION=$1
ARG1=$2
ARG2=$3
ARG3=$4
ARG4=$5

# Check if running as root
if [ "$EUID" -ne 0 ]; then
  echo "Please run this script with root privileges"
  exit 1
fi

# Generate random ID (6 characters)
generate_id() {
    # Introduce nanoseconds and random salt to ensure ID uniqueness even if the script runs quickly
    echo "$RANDOM $(date +%s%N)" | md5sum | head -c 6
}

# Show help information
usage() {
    echo "Usage: $0 {add|del|list|save} [parameters]"
    echo ""
    echo "Commands:"
    echo "  add <Public Port> <Internal IP> <Internal Port> [Protocol]   Add forwarding rule"
    echo "      [Protocol] optional: tcp, udp, both (default: both)"
    echo "  del <ID>                                   Delete forwarding rule by ID"
    echo "  list                                       View all current forwarding rules"
    echo "  save                                       Save current rules to persist after reboot (Must run!)"
    echo ""
    echo "Examples:"
    echo "  $0 add 8080 192.168.100.101 80 both"
    echo "  $0 save"
    echo ""
}

# Internal function: add single protocol rule
_add_single_rule() {
    local PROTO=$1
    local L_PORT=$2
    local T_IP=$3
    local T_PORT=$4

    local RULE_ID=$(generate_id)
    local COMMENT="NAT_ID:${RULE_ID}"

    # 1. Add DNAT rule (PREROUTING chain)
    iptables -t nat -A PREROUTING -i $PUB_IF -p $PROTO --dport $L_PORT -j DNAT --to-destination $T_IP:$T_PORT -m comment --comment "$COMMENT"

    # 2. Add FORWARD rule (Allow packet passage)
    iptables -A FORWARD -p $PROTO -d $T_IP --dport $T_PORT -m comment --comment "$COMMENT" -j ACCEPT

    # Output result
    printf "%-10s %-10s %-10s %-20s %-10s\n" "$RULE_ID" "$PROTO" "$L_PORT" "$T_IP:$T_PORT" "Success"
    
    # Remind user to save
    echo "Please run '$0 save' to ensure rules persist after reboot."
}

# Main add function
add_rule() {
    local L_PORT=$1
    local T_IP=$2
    local T_PORT=$3
    local PROTO_REQ=${4:-both} # Default to both

    if [[ -z "$L_PORT" || -z "$T_IP" || -z "$T_PORT" ]]; then
        echo "Error: Missing parameters"
        usage
        exit 1
    fi

    # Convert to lowercase
    PROTO_REQ=$(echo "$PROTO_REQ" | tr '[:upper:]' '[:lower:]')

    echo "Adding rule..."
    printf "%-10s %-10s %-10s %-20s %-10s\n" "ID" "Protocol" "Public Port" "Target Address" "Status"
    echo "------------------------------------------------------------------"

    if [[ "$PROTO_REQ" == "tcp" ]]; then
        _add_single_rule "tcp" "$L_PORT" "$T_IP" "$T_PORT"
    elif [[ "$PROTO_REQ" == "udp" ]]; then
        _add_single_rule "udp" "$L_PORT" "$T_IP" "$T_PORT"
    elif [[ "$PROTO_REQ" == "both" ]]; then
        _add_single_rule "tcp" "$L_PORT" "$T_IP" "$T_PORT"
        _add_single_rule "udp" "$L_PORT" "$T_IP" "$T_PORT"
    else
        echo "Error: Unsupported protocol '$PROTO_REQ'. Please use tcp, udp, or both."
        exit 1
    fi
    echo "------------------------------------------------------------------"
}

# Delete rule (Delete in reverse line number order)
del_rule() {
    local RULE_ID=$1

    if [[ -z "$RULE_ID" ]]; then
        echo "Error: Please provide rule ID"
        usage
        exit 1
    fi

    echo "Searching for rule with ID [${RULE_ID}]..."
    
    local FOUND=0

    # --- Clean NAT table (PREROUTING) ---
    LINES=$(iptables -t nat -nL PREROUTING --line-numbers | grep "NAT_ID:${RULE_ID}" | awk '{print $1}' | sort -rn)
    if [[ ! -z "$LINES" ]]; then
        for line in $LINES; do
            iptables -t nat -D PREROUTING $line
            echo "Deleted NAT table PREROUTING chain line $line"
            FOUND=1
        done
    fi

    # --- Clean Filter table (FORWARD) ---
    LINES=$(iptables -t filter -nL FORWARD --line-numbers | grep "NAT_ID:${RULE_ID}" | awk '{print $1}' | sort -rn)
    if [[ ! -z "$LINES" ]]; then
        for line in $LINES; do
            iptables -t filter -D FORWARD $line
            echo "Deleted Filter table FORWARD chain line $line"
            FOUND=1
        done
    fi

    if [[ $FOUND -eq 0 ]]; then
        echo "No rule found with ID $RULE_ID."
    else
        echo "Delete operation completed."
        echo "Please run '$0 save' to update the persistent configuration file."
    fi
}

# Save rules to disk (New feature)
save_rules() {
    echo "Saving current iptables rules..."
    # netfilter-persistent is the service managing iptables-persistent in Debian/Proxmox
    if command -v netfilter-persistent &> /dev/null; then
        netfilter-persistent save
        if [ $? -eq 0 ]; then
            echo "✅ Rules successfully saved to /etc/iptables/rules.v4, will be automatically restored after system reboot."
        else
            echo "❌ Failed to save rules. Please check the status of the 'netfilter-persistent' service."
        fi
    else
        echo "Warning: 'netfilter-persistent' command not found."
        echo "Please ensure the 'iptables-persistent' package is installed."
        echo "Install command: apt update && apt install iptables-persistent"
    fi
}

# List rules
list_rules() {
    echo "Current Port Forwarding Rules List:"
    printf "%-10s %-10s %-10s %-20s %-10s\n" "ID" "Protocol" "Public Port" "Target Address" "Target Port"
    echo "------------------------------------------------------------------"

    # Parse iptables output
    iptables -t nat -nL PREROUTING -v | grep "NAT_ID:" | while read line; do
        id=$(echo "$line" | grep -oP '(?<=NAT_ID:)[^ ]*')
        
        # Extract protocol
        if echo "$line" | grep -q "tcp"; then proto="tcp"; else proto="udp"; fi
        
        # Extract port after dpt:
        l_port=$(echo "$line" | grep -oP '(?<=dpt:)[0-9]+')
        
        # Extract IP:Port after to:
        target=$(echo "$line" | grep -oP '(?<=to:).*')
        t_ip=${target%:*}
        t_port=${target#*:}

        printf "%-10s %-10s %-10s %-20s %-10s\n" "$id" "$proto" "$l_port" "$t_ip" "$t_port"
    done
}

# Main logic
case "$ACTION" in
    add)
        add_rule "$ARG1" "$ARG2" "$ARG3" "$ARG4"
        ;;
    del)
        del_rule "$ARG1"
        ;;
    list)
        list_rules
        exit 0
        ;;
    save)
        save_rules
        ;;
    *)
        usage
        exit 1
        ;;
esac
save_rules
```
This script automatically adds/deletes iptables rules for port forwarding. Remember to `chmod +x`.

Use `iptables-persistent` to save the configuration and load it automatically on boot:
```shell
apt install iptables-persistent
```
During configuration, you will be asked whether to save the current rules; Yes or No is fine.

When adding a forwarding rule, use `natmgr add <host listen port> <VM internal IP> <VM port> [tcp/udp/both]`. The script will automatically assign a unique ID. Use `natmgr del <ID>` to delete. Use `natmgr list` to view the existing forwarding list.

-----
**Reference Articles:**
1. [bin456789/reinstall: 一键DD/重装脚本 (One-click reinstall OS on VPS) - GitHub](https://github.com/bin456789/reinstall)
2. [Install Proxmox VE on Debian 12 Bookworm - Proxmox VE](https://pve.proxmox.com/wiki/Install_Proxmox_VE_on_Debian_12_Bookworm)
3. [PVE连接 TrueNAS iSCSI存储实现本地无盘化_pve iscsi-CSDN博客](https://blog.csdn.net/qq_26129413/article/details/121790221)
4. [ProxmoxVE (PVE) NAT 网络配置方法 - Oskyla 烹茶室](https://frytea.com/archives/1445/)
