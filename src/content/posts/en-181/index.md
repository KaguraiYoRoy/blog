---
title: "Configuring Multi-Exit Routing for a Dual-NIC VPS Using PBR"
published: 2025-09-14T09:07:00.000Z
updated: 2025-12-14T13:27:03.000Z
description: "Configuring outbound routing on a dual-NIC IEPL VPS with Netplan route metrics, separate routing tables, and policy rules to select a gateway for specific traffic."
image: ""
tags: ["Network Technology", "PBR", "IEPL"]
category: "Network"
categories: ["Network"]
draft: false
lang: "en_US"
---

> Warning: This is a low-value/watered-down post

# Background
I got a Shenzhen-Hong Kong IEPL machine from a friend. It has two network interfaces, `eth0` and `eth1`, but by default, all traffic goes through `eth0`. `eth1` had no routing configured.
I planned to use metrics for basic traffic splitting initially, and then use PBR (Policy-Based Routing) to implement rule-based routing configuration.

# Configuration
The machine's network was initially configured by cloud-init:  
```yaml
# This file is generated from information provided by the datasource. Changes
# to it will not persist across an instance reboot. To disable cloud-init's
# network configuration capabilities, write a file
# /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg with the following:
# network: {config: disabled}
network:
    version: 2
    ethernets:
        eth0:
            addresses:
            - 10.10.1.31/16
            gateway4: 10.10.0.1
            match:
                macaddress: bc:24:11:f8:42:7a
            nameservers:
                addresses:
                - 223.5.5.5
                - 119.29.29.29
                search:
                - [REDACTED]
            set-name: eth0
        eth1:
            addresses:
            - 10.20.1.31/16
            - [REDACTED]/64
            gateway4: 10.20.0.1
            gateway6: fe80::be24:11ff:fe80:66bb
            match:
                macaddress: bc:24:11:50:96:0a
            nameservers:
                addresses:
                - 223.5.5.5
                - 119.29.29.29
                search:
                - [REDACTED]
            set-name: eth1
```

After backing up the config, I added metrics:  
```diff
# This file is generated from information provided by the datasource. Changes
# to it will not persist across an instance reboot. To disable cloud-init's
# network configuration capabilities, write a file
# /etc/cloud/cloud.cfg.d/99-disable-network-config.cfg with the following:
# network: {config: disabled}
network:
    version: 2
    ethernets:
        eth0:
            addresses:
            - 10.10.1.31/16
            gateway4: 10.10.0.1
            match:
                macaddress: bc:24:11:f8:42:7a
            nameservers:
                addresses:
                - 223.5.5.5
                - 119.29.29.29
                search:
                - [REDACTED]
            set-name: eth0
+           routes:
+             - to: "default"
+               via: "10.10.0.1"
+               # Set metric=50 as the backup exit
+               metric: 50
        eth1:
            addresses:
            - 10.20.1.31/16
            - [REDACTED]/64
            gateway4: 10.20.0.1
            gateway6: fe80::be24:11ff:fe80:66bb
            match:
                macaddress: bc:24:11:50:96:0a
            nameservers:
                addresses:
                - 223.5.5.5
                - 119.29.29.29
                search:
                - [REDACTED]
            set-name: eth1
+           routes:
+             - to: "default"
+               via: "10.20.0.1"
+               # Set metric=25 as the preferred exit
+               metric: 25
```

Create the PBR configuration:  
```yaml
# /etc/netplan/90-pbr.yaml
network:
  version: 2
  ethernets:
    eth0:
      routes:
        - to: default
          via: 10.10.0.1
          table: 10
      routing-policy:
        - from: 10.10.0.0/16
          table: 10
        - to: 202.46.[REDACTED]/32
          table: 10
    eth1:
      routes:
        - to: default
          via: 10.20.0.1
          table: 20
      routing-policy:
        - from: 10.20.0.0/16
          table: 20
        - to: 38.47.[REDACTED]/32
          table: 20
        - to: 23.149.[REDACTED]/32
          table: 20
```
For IPs that need to be accessed via a specific exit, just add a 'to' type rule and bind it to the corresponding routing table.  

After finishing, run  
```bash
netplan apply
```
to update the configuration.