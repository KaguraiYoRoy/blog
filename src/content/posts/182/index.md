---
title: "DN42&OneManISP - 使用VRF实现公网BGP和DN42共用一台机器"
published: 2025-09-16T14:47:00.000Z
updated: 2026-01-05T03:23:09.000Z
description: "尝试用 VRF 在同一台 VPS 上隔离 DN42 与公网路由，记录接口、WireGuard 和 BIRD 配置，以及访问宿主机服务时遇到的限制。"
image: ""
tags: ["BGP", "BIRD", "网络技术", "OSPF", "内部路由协议", "VRF"]
category: "网络技术"
categories: ["网络技术", "DN42", "个人ISP"]
draft: false
lang: "zh_CN"
---

# 背景
目前同一区域内公网BGP和DN42分别用了一台VPS，也就是说同一个区域需要两台机器。从群友那里得知了VRF，便想着通过VRF实现同一台机器同时处理公网BGP并加入DN42。

> 注意：VRF方案因为其隔离性，会导致DN42无法访问主机的服务。如果你需要在服务器上跑诸如DNS之类的服务给DN42用，你可能需要再单独配置端口转发或者veth，但是不在本文讨论范围内。（这也是我实际生产环境最终还是没有采用VRF的原因）

# VRF的优点
虽然说DN42使用的IP段是私有地址，并且它的ASN用的都是内部ASN，理论上不会和公网BGP相互干扰，但是如果共用同一张路由表，可能会造成路由污染、管理复杂等问题。  

VRF（Virtual Routing and Forwarding，虚拟路由转发）可以实现在一台机器上创建多个路由表，也就是说我们可以通过它将DN42的路由单独放到一个路由表里，以实现将DN42路由表和公网路由表相隔离。这么做的优点有：  
* **路由与策略隔离**：将 DN42 和公网路由放入不同路由表，减少意外混用的机会。是否会发生路由泄漏仍取决于 BIRD 的导入导出过滤器及跨表配置，VRF 本身不能保证绝对安全。
* **清晰的运维管理**：可以使用`birdc show route table t_dn42`和`birdc show route table t_inet`来分别查看和调试两张完全独立的路由表，一目了然。
* **减少路由变化的相互影响**：DN42 对等体抖动时，相关变化可以留在对应的路由表中。但两套路由仍共享主机的 CPU、内存和网卡资源，不能据此认为它们在性能和故障上完全隔离。
* **更符合现代网络设计理念**：在现代网络工程中，为不同的路由域（生产、测试、客户、合作伙伴）使用VRF是标准做法。它将你的设备逻辑上划分成了多个虚拟路由器。

# 配置
## 系统部分
### 创建VRF设备

使用以下指令创建一个名为`dn42-vrf`的VRF设备并关联到系统的`1042`号路由表：
```shell
ip link add dn42-vrf type vrf table 1042
ip link set dev dn42-vrf up # 启用
```
路由表号可以按照你自己的喜好修改，但是请避开以下几个保留路由表编号：
| 名称 | ID  | 说明 |
| --- | --- | --- |
| `unspec` | 0 | 未指定，基本不用 |
| `main` | 254 | **主路由表**，大多数普通路由都放在这里 |
| `default` | 253 | 一般不用，保留 |
| `local` | 255 | 本机路由表，存放`127.0.0.1/8`、本机 IP、广播地址等，不能改 |

### 将现有的相应网卡关联到VRF
按照我目前的DN42网络为例，有若干WireGuard网卡和一个dummy网卡是用于DN42的，因此将这几个网卡都关联到VRF中：
```shell
ip link set dev <网卡名> master dn42-vrf 
```
需要注意的是，网卡关联到VRF之后可能会丢失地址，因此需要重新为其添加一次地址，如：
```shell
ip addr add 172.20.234.225 dev dn42
```
完成之后，通过`ip a`应该能看到对应网卡的master是dn42-vrf：
```shell
156: dn42: <BROADCAST,NOARP,UP,LOWER_UP> mtu 1500 qdisc noqueue master dn42-vrf state UNKNOWN group default qlen 1000
    link/ether b6:f5:28:ed:23:04 brd ff:ff:ff:ff:ff:ff
    inet 172.20.234.225/32 scope global dn42
       valid_lft forever preferred_lft forever
    inet6 fd18:3e15:61d0::1/128 scope global 
       valid_lft forever preferred_lft forever
    inet6 fe80::b4f5:28ff:feed:2304/64 scope link 
       valid_lft forever preferred_lft forever
```

### 持久化
我使用了ifupdown2来实现开机自动加载dummy网卡和VRF设备。  
```plain
auto dn42-vrf
iface dn42-vrf inet manual
    vrf-table 1042

auto dn42
iface dn42 inet static
    pre-up ip link add $IFACE type dummy || true
    vrf dn42-vrf
    address <IPv4 Address>/32
    address <IPv6 Address>/128
    post-down ip link del $IFACE
```
我的dummy网卡名称为`dn42`，如果你的名称不一样请按需要修改。创建完后使用`ifup dn42-vrf && ifup dn42`即可启动dummy网卡和VRF。  

## WireGuard隧道
添加PostUp使其关联到vrf并重新为其绑定地址。举个例子：

```diff
[Interface]
PrivateKey = [数据删除]
ListenPort = [数据删除]
Table = off
Address = fe80::2024/64
+ PostUp = ip link set dev %i master dn42-vrf
+ PostUp = ip addr add fe80::2024/64 dev %i
PostUp = sysctl -w net.ipv6.conf.%i.autoconf=0

[Peer]
PublicKey = [数据删除]
Endpoint = [数据删除]
AllowedIPs = 10.0.0.0/8, 172.20.0.0/14, 172.31.0.0/16, fd00::/8, fe00::/8
```

然后重新启动隧道即可。

## Bird2部分
首先我们需要定义两张路由表，分别用于dn42的IPv4和IPv6：
```plain
ipv4 table dn42_table_v4;
ipv6 table dn42_table_v6
```

随后，在kernel protocol中指定VRF和系统路由表编号，并在IPv4、IPv6中指定前面创建的v4、v6路由表：
```diff
protocol kernel dn42_kernel_v6{
+   vrf "dn42-vrf";
+   kernel table 1042;
    scan time 20;

    ipv6 {
+       table dn42_table_v6;
        import none;
        export filter {
            if source = RTS_STATIC then reject;
            krt_prefsrc = DN42_OWNIPv6;
            accept;
        };
    };
};

protocol kernel dn42_kernel_v4{
+   vrf "dn42-vrf";
+   kernel table 1042;
    scan time 20;

    ipv4 {
+       table dn42_table_v4;
        import none;
        export filter {
            if source = RTS_STATIC then reject;
            krt_prefsrc = DN42_OWNIP;
            accept;
        };
    };
}

```

除了kernel以外的protocol都加上VRF和IPv4、IPv6独立的table，但不需要指定系统路由表编号：
```diff
protocol static dn42_static_v4{
+   vrf "dn42-vrf";
    route DN42_OWNNET reject;

    ipv4 {
+       table dn42_table_v4;
        import all;
        export none;
    };
}

protocol static dn42_static_v6{
+   vrf "dn42-vrf";
    route DN42_OWNNETv6 reject;

    ipv6 {
+       table dn42_table_v6;
        import all;
        export none;
    };
}
```

总而言之就是：
* 一切和DN42有关的都给配置一个VRF和之前定义的路由表
* 只有kernel协议需要指定系统路由表编号，其他不需要

对于BGP、OSPF等也如法炮制，不过我选择将公网的RouterID和DN42的分开，因此还需要单独配置一个RouterID：  
```diff
# /etc/bird/dn42/ospf.conf
protocol ospf v3 dn42_ospf_iyoroynet_v4 {
+   vrf "dn42-vrf";
+   router id DN42_OWNIP;
    ipv4 {
+       table dn42_table_v4;
        import where is_self_dn42_net() && source != RTS_BGP;
        export where is_self_dn42_net() && source != RTS_BGP;
    };

    include "ospf/*";
};

protocol ospf v3 dn42_ospf_iyoroynet_v6 {
+   vrf "dn42-vrf";
+   router id DN42_OWNIP;
    ipv6 {
+       table dn42_table_v6;
        import where is_self_dn42_net_v6() && source != RTS_BGP;
        export where is_self_dn42_net_v6() && source != RTS_BGP;
    };

    include "ospf/*";
};
```

```diff
# /etc/bird/dn42/ebgp.conf
...
template bgp dnpeers {
+   vrf "dn42-vrf";
+   router id DN42_OWNIP;
    local as DN42_OWNAS;
    path metric 1;

    ipv4 {
+       table dn42_table_v4;
        ...
    };

    ipv6 {
+       table dn42_table_v6;
        ...
    };
}

include "peers/*";
```

完成后`birdc c`重载配置即可。  
这时，我们可以通过`ip route show vrf dn42-vrf`来单独查看DN42的路由表：
```plain
root@iYoRoyNetworkHKGBGP:~# ip route show vrf dn42-vrf
10.26.0.0/16 via inet6 fe80::ade0 dev dn42_4242423914 proto bird src 172.20.234.225 metric 32 
10.29.0.0/16 via inet6 fe80::ade0 dev dn42_4242423914 proto bird src 172.20.234.225 metric 32 
10.37.0.0/16 via inet6 fe80::ade0 dev dn42_4242423914 proto bird src 172.20.234.225 metric 32 
...
```

也可以在Ping的时候通过参数`-I dn42-vrf`来实现通过VRF Ping：
```shell
root@iYoRoyNetworkHKGBGP:~# ping 172.20.0.53 -I dn42-vrf
ping: Warning: source address might be selected on device other than: dn42-vrf
PING 172.20.0.53 (172.20.0.53) from 172.20.234.225 dn42-vrf: 56(84) bytes of data.
64 bytes from 172.20.0.53: icmp_seq=1 ttl=64 time=3.18 ms
64 bytes from 172.20.0.53: icmp_seq=2 ttl=64 time=3.57 ms
64 bytes from 172.20.0.53: icmp_seq=3 ttl=64 time=3.74 ms
64 bytes from 172.20.0.53: icmp_seq=4 ttl=64 time=2.86 ms
^C
--- 172.20.0.53 ping statistics ---
4 packets transmitted, 4 received, 0% packet loss, time 3006ms
rtt min/avg/max/mdev = 2.863/3.337/3.740/0.341 ms
```

# 注意事项
* 如果vrf设备重载了，所有原先和vrf相关联的设备都需要重载一次，否则无法正常工作
* 目前DN42是无法访问到配置了VRF的主机内的服务的，后续可能出一篇文章讲一下如何去让VRF内的流量可以访问到主机服务（挖坑ing）
* 从朋友那里了解到，可以通过设置`net.ipv4.tcp_l3mdev_accept=1`和`net.ipv4.udp_l3mdev_accept=1`来允许全局空间的监听套接字接受来自VRF域的连接请求，实现跨vrf监听服务。

---
参考文章：
* [用 BIRD 运行你的 MPLS 网络](https://blog.sherpherd.net/2024/02/11/RunYourMPLSNetworkWithBIRD_zh-cn.html)