---
title: "通过PBR为双网卡VPS配置多出口路由"
published: 2025-09-14T09:07:00.000Z
updated: 2025-09-17T00:17:08.000Z
description: "为一台深港 IEPL 双网卡 VPS 配置出口，先用 Netplan 设置路由 metric，再通过独立路由表和策略路由规则指定流量走哪个网关。"
image: ""
tags: ["网络技术", "PBR", "IEPL"]
category: "网络技术"
categories: ["网络技术"]
draft: false
lang: "zh_CN"
---

> 水文警告

# 背景
从朋友那里弄到一台深港IEPL机器，有两个网卡`eth0`和`eth1`，但是默认都走`eth0`，`eth1`没有配置路由。  
我打算通过metric实现粗略的分流再通过PBR实现按照规则的路由配置。

# 配置
机器默认由cloudinit配置了网卡：
```yaml
# This file is generated from information provided by the datasource.  Changes
# to it will not persist across an instance reboot.  To disable cloud-init's
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
                - [数据删除]
            set-name: eth0
        eth1:
            addresses:
            - 10.20.1.31/16
            - [数据删除]/64
            gateway4: 10.20.0.1
            gateway6: fe80::be24:11ff:fe80:66bb
            match:
                macaddress: bc:24:11:50:96:0a
            nameservers:
                addresses:
                - 223.5.5.5
                - 119.29.29.29
                search:
                - [数据删除]
            set-name: eth1
```
备份一份配置之后加上metric：
```diff
# This file is generated from information provided by the datasource.  Changes
# to it will not persist across an instance reboot.  To disable cloud-init's
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
                - [数据删除]
            set-name: eth0
+           routes:
+             - to: "default"
+               via: "10.10.0.1"
+               # 设置 metric=50，作为备选出口
+               metric: 50
        eth1:
            addresses:
            - 10.20.1.31/16
            - [数据删除]/64
            gateway4: 10.20.0.1
            gateway6: fe80::be24:11ff:fe80:66bb
            match:
                macaddress: bc:24:11:50:96:0a
            nameservers:
                addresses:
                - 223.5.5.5
                - 119.29.29.29
                search:
                - [数据删除]
            set-name: eth1
+           routes:
+             - to: "default"
+               via: "10.20.0.1"
+               # 设置 metric=25，作为优先出口
+               metric: 25
```

编写PBR配置：
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
        - to: 202.46.[数据删除]/32
          table: 10
    eth1:
      routes:
        - to: default
          via: 10.20.0.1
          table: 20
      routing-policy:
        - from: 10.20.0.0/16
          table: 20
        - to: 38.47.[数据删除]/32
          table: 20
        - to: 23.149.[数据删除]/32
          table: 20
```

对于需要指定出口访问的IP为其加上to类型的规则并绑定对应路由表即可。  


完成后运行
```bash
netplan apply
```
更新配置