---
title: "DN42&OneManISP - Using VRF to Run Clearnet BGP and DN42 on the Same Machine"
published: 2025-09-16T14:47:00.000Z
updated: 2026-01-05T03:23:30.000Z
description: "A guide on using VRF to isolate DN42 and public BGP routing on a single machine, including configuration steps for Linux network interfaces, WireGuard tunnels, and Bird2."
image: ""
tags: ["BGP", "BIRD", "Network Technology", "OSPF", "Interior Gateway Protocol", "VRF"]
category: "Network"
draft: false
lang: "en_US"
---

# Background
Currently, clearnet BGP and DN42 each use a separate VPS in the same region, meaning two machines are required per region. After learning about VRF from a group member, I explored using VRF to enable a single machine to handle both clearnet BGP and DN42 simultaneously.  

> Note: Due to its isolation nature, the VRF solution will prevent DN42 from accessing services on the host. If you need to run services (like DNS) on the server for DN42, you might need additional port forwarding or veth configuration, which is beyond the scope of this article. (This is also the reason why I ultimately did not adopt VRF in my production environment).

# Advantages of VRF
Although DN42 uses private IP ranges and internal ASNs, which theoretically shouldn't interfere with clearnet BGP, sharing the same routing table can lead to issues like route pollution and management complexity.  

VRF (Virtual Routing and Forwarding) allows creating multiple routing tables on a single machine. This means we can isolate DN42 routes into a separate routing table, keeping them apart from the clearnet routing table. The advantages include:  

* **Absolute Security and Policy Isolation**: The DN42 routing table is isolated from the clearnet routing table, fundamentally preventing route leaks.
* **Clear Operation and Management**: Use commands like `birdc show route table t_dn42` and `birdc show route table t_inet` to view and debug two completely independent routing tables, making things clear at a glance.
* **Fault Domain Isolation**: If a DN42 peer flaps, the impact is confined to the dn42 routing table. It won't consume routing computation resources for the clearnet instance nor affect clearnet forwarding performance.
* **Alignment with Modern Network Design Principles**: Using VRF for different routing domains (production, testing, customer, partner) is standard practice in modern network engineering. It logically divides your device into multiple virtual routers.

# Configuration
## System Part
### Creating the VRF Interface

Use the following commands to create a VRF device named `dn42-vrf` and associate it with the system's routing table number `1042`:
```shell
ip link add dn42-vrf type vrf table 1042
ip link set dev dn42-vrf up # Enable it
```
You can change the routing table number according to your preference, but avoid the following reserved routing table IDs:  
| Name | ID  | Description |
| --- | --- | --- |
| `unspec` | 0 | Unspecified, rarely used |
| `main` | 254 | **Main routing table**, where most ordinary routes reside |
| `default` | 253 | Generally unused, reserved |
| `local` | 255 | Local routing table, contains `127.0.0.1/8`, local IPs, broadcast addresses, etc. Cannot be modified |

### Associating Existing Network Interfaces with VRF
In my current DN42 setup, several WireGuard interfaces and a dummy interface are used for DN42. Therefore, associate these interfaces with the VRF:  
```shell
ip link set dev <interface_name> master dn42-vrf
```
Note: After associating an interface with a VRF, it might lose its IP addresses. Therefore, you need to readd the addresses, for example:  
```shell
ip addr add 172.20.234.225 dev dn42
```
After completion, ip a should show the corresponding interface's master as dn42-vrf:  
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

### Persistence
I use ifupdown2 to automatically load the dummy interface and VRF device on boot.  
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

My dummy interface is named `dn42`; modify accordingly if yours is different. After creation, use `ifup dn42-vrf && ifup dn42` to start the dummy interface.

Note: The number prefix for the VRF device file should be smaller than that of the dummy interface file, ensuring the VRF device starts first.  

## WireGuard Tunnels
Add PostUp commands to associate them with the VRF and readd their addresses. Example:  

```diff
[Interface]
PrivateKey = [Data Redacted]
ListenPort = [Data Redacted]
Table = off
Address = fe80::2024/64
+ PostUp = ip link set dev %i master dn42-vrf
+ PostUp = ip addr add fe80::2024/64 dev %i
PostUp = sysctl -w net.ipv6.conf.%i.autoconf=0

[Peer]
PublicKey = [Data Redacted]
Endpoint = [Data Redacted]
AllowedIPs = 10.0.0.0/8, 172.20.0.0/14, 172.31.0.0/16, fd00::/8, fe00::/8
```

Then restart the tunnel.

## Bird2 Part
First, define two routing tables for DN42's IPv4 and IPv6:  
```plain
ipv4 table dn42_table_v4;
ipv6 table dn42_table_v6
```

Then, specify the VRF and system routing table number in the kernel protocol, and specify the previously created v4/v6 routing tables in the IPv4/IPv6 sections:  
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

For protocols other than kernel, add the VRF and the independent IPv4/IPv6 tables, but do not specify the system routing table number:  
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

In summary:
* Configure a VRF and the previously defined routing tables for everything related to DN42.
* Only the kernel protocol needs the system routing table number specified; others do not.

Apply the same method to BGP, OSPF, etc. However, I chose to use separate Router IDs for the clearnet and DN42, so a separate Router ID needs to be configured:  
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

After completion, reload the configuration with `birdc c`.  
Now, we can view the DN42 routing table separately using `ip route show vrf dn42-vrf`:
```plain
root@iYoRoyNetworkHKGBGP:~# ip route show vrf dn42-vrf
10.26.0.0/16 via inet6 fe80::ade0 dev dn42_4242423914 proto bird src 172.20.234.225 metric 32 
10.29.0.0/16 via inet6 fe80::ade0 dev dn42_4242423914 proto bird src 172.20.234.225 metric 32 
10.37.0.0/16 via inet6 fe80::ade0 dev dn42_4242423914 proto bird src 172.20.234.225 metric 32 
...
```

You can also ping through the VRF using the `-I dn42-vrf` parameter:
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

# Important Notes
* If the VRF device is reloaded, all devices originally associated with the VRF need to be reloaded as well, otherwise they won't function correctly.
* Currently, DN42 cannot access services inside the host configured with VRF. A future article might explain how to allow traffic within the VRF to access host services (Adding to the TODO list).
* I learned from a friend that by setting `net.ipv4.tcp_l3mdev_accept=1` and `net.ipv4.udp_l3mdev_accept=1`, it is possible to allow the listening sockets in the global space to accept connection requests from the VRF domain, thus achieving cross-vrf listening services.

---
Reference Articles:：
* [Run your MPLS network with BIRD](https://blog.sherpherd.net/2024/02/11/RunYourMPLSNetworkWithBIRD_en.html)