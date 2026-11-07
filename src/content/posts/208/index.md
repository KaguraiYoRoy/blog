---
title: "DN42&OneManISP - 共存环境下的OSPF源地址故障排除"
published: 2025-10-29T12:42:00.000Z
updated: 2025-11-09T05:57:24.000Z
description: "记录在DN42与公网BGP共存环境中部署BIRD路由时遇到的OSPF源地址选择问题。详细分析多协议路由共存场景下的内核路由表冲突，通过调整OSPF导入阶段的krt_prefsrc参数，解决内部节点间通信故障，实现DN42与公网BGP的稳定并行运行。"
image: ""
tags: ["DN42", "BGP", "BIRD", "OSPF"]
category: "网络技术"
categories: ["网络技术", "DN42", "个人ISP"]
draft: false
lang: "zh_CN"
---

# 前情提要 
正如这个系列的上文所说，因为VRF方案太过于隔离，导致我部署在HKG节点（172.20.234.225）的DNS服务无法被DN42网络所访问，查阅资料得知可以通过设置veth或者NAT地址转发的方式来实现，但是因为现有的资料比较少，最终还是放弃了VRF这个方案。

# 结构分析
这次我打算将DN42和公网BGP的路由都放入系统的主路由表，然后再分开导出，通过过滤器来区分是否应该导出。同时，为了更加直观，我将DN42部分的配置和公网（以下简称inet）部分的配置分别单独存放，再由主配置文件引入。同时，因为kernel部分配置一个路由表只应该存在一个，因此合并DN42和inet的kernel部分，仅保留一个。

经过多次优化和修改，我最终的目录结构如下：
```text
/etc/bird/
├─envvars
├─bird.conf: Bird主配置文件，负责定义基本信息（ASN、IP等），引入下面的子配置
├─kernel.conf: 内核配置，负责将路由导入系统路由表
├─dn42
|  ├─defs.conf: DN42的函数定义，如is_self_dn42_net()这类
|  ├─ibgp.conf: DN42 iBGP模板
|  ├─rpki.conf: DN42 RPKI路由验证
|  ├─ospf.conf: DN42 OSPF内网
|  ├─static.conf: DN42静态路由
|  ├─ebgp.conf: DN42 Peer模板
|  ├─ibgp
|  |  └<ibgp configs>: DN42 iBGP各个节点的配置
|  ├─ospf
|  |  └backbone.conf: OSPF区域
|  ├─peers
|  |  └<ibgp configs>: DN42 Peer各个节点的配置
├─inet
|  ├─peer.conf: 公网Peer
|  ├─ixp.conf: 公网IXP接入
|  ├─defs.conf: 公网部分的函数定义，如is_self_inet_v6()
|  ├─upstream.conf: 公网上游
|  └static.conf: 公网静态路由
```

将定义函数的部分单独拿出来是因为我需要在`kernel.conf`的过滤器中引用，因此单独拿出来以便于提前`include`。

完成后分别填入对应配置，然后由写好include关系，`birdc configure`后发现也成功跑起来了。于是乎告一段落...吗?

# 发现问题
运行一段时间后，我突然发现通过我的内网设备Ping HKG节点无法Ping通，通过HKG节点Ping我的其他内部节点也无法Ping通。奇怪的是，外部AS可以通过我的HKG节点Ping到我的其他节点或者其他外部AS，我的内部节点也可以通过HKG节点Ping到其他不直接相连的节点（如：226(NKG)->225(HKG)->229(LAX)）。
通过`ip route get <内网其他节点地址>`发现：
```shell
root@iYoRoyNetworkHKG:/etc/bird# ip route get 172.20.234.226
172.20.234.226 via 172.20.234.226 dev dn42_nkg src 23.149.120.51 uid 0
    cache
```
看出问题了吗？src地址本来应该是HKG节点自己的DN42地址（OSPF部分stub网卡配置的），但是这里显示的却是HKG节点的公网地址。
尝试通过`birdc s r for 172.20.234.226`读取bird学习到的路由：
```shell
root@iYoRoyNetworkHKGBGP:/etc/bird/dn42/ospf# birdc s r for 172.20.234.226
BIRD 2.17.1 ready.
Table master4:
172.20.234.226/32    unicast [dn42_ospf_iyoroynet_v4 00:30:29.307] * I (150/50) [172.20.234.226]
        via 172.20.234.226 on dn42_nkg onlink
```
看起来貌似一切正常...?
理论上来说，虽然DN42的源IP和正常的不太一样，但是DN42在导出到内核的时候改写了`krt_prefsrc`来告诉内核正确的源地址，理论上不应该出现这样的问题：
```diff
protocol kernel kernel_v4{  
    ipv4 {
        import none;
        export filter {
            if source = RTS_STATIC then reject;
+            if is_valid_dn42_network() then krt_prefsrc = DN42_OWNIP;
            accept;
        };
    };
}

protocol kernel kernel_v6 {
    ipv6 {
        import none;
        export filter {
            if source = RTS_STATIC then reject;
+            if is_valid_dn42_network_v6() then krt_prefsrc = DN42_OWNIPv6;
            accept;
        };
    };
}
```
* 关于`krt_prefsrc`，其含义是**Kernel Route Preferred Source**。这个属性并非直接操作路由，而是为路由附加一个**元数据**，它直接告诉 Linux 内核：**当通过这条路由发送数据包时，应优先使用这里指定的 IP 地址作为源地址**。

在这里卡了好久的说  

# 解决方案
最终，某次无意间尝试给OSPF的导出配置中也加上了`krt_prefsrc`改写：
```diff
protocol ospf v3 dn42_ospf_iyoroynet_v4 {
    router id DN42_OWNIP;
    ipv4 {
-        import where is_self_dn42_net() && source != RTS_BGP;
+        import filter {
+            if is_self_dn42_net() && source != RTS_BGP then {
+                krt_prefsrc=DN42_OWNIP;
+                accept;
+            }
+            reject;
+        };
        export where is_self_dn42_net() && source != RTS_BGP;
    };

    include "ospf/*";
};

protocol ospf v3 dn42_ospf_iyoroynet_v6 {
    router id DN42_OWNIP;
    ipv6 {
-        import where is_self_dn42_net_v6() && source != RTS_BGP;
+        import filter {
+            if is_self_dn42_net_v6() && source != RTS_BGP then {
+                krt_prefsrc=DN42_OWNIPv6;
+                accept;
+            }
+            reject;
+        };
        export where is_self_dn42_net_v6() && source != RTS_BGP;
    };

    include "ospf/*";
};
```
之后再运行发现src地址正确了，互相Ping也都能通。

---
配置文件可参考：[KaguraiYoRoy/Bird2-Configuration](https://github.com/KaguraiYoRoy/Bird2-Configuration/tree/main/hkg-cn)