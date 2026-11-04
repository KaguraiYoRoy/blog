---
title: "DN42&OneManISP - Troubleshooting OSPF Source Address in a Coexistence Environment"
published: 2025-10-29T12:42:00.000Z
updated: 2025-11-09T05:57:24.000Z
description: "Troubleshooting failed pings between DN42 nodes after combining DN42 and clearnet routes, using ip route get to spot the wrong source address and adjusting BIRD's krt_prefsrc."
image: ""
tags: ["DN42", "BGP", "BIRD", "OSPF"]
category: "Network"
categories: ["Network", "DN42", "One Man ISP"]
draft: false
lang: "en_US"
---

# Backstory 
As mentioned in the previous post of this series, because the VRF solution was too isolating, the DNS service I deployed on the HKG node (172.20.234.225) became inaccessible from the DN42 network. Research indicated this could be achieved by setting up veth or NAT forwarding, but due to the scarcity of available documentation, I ultimately abandoned the VRF approach.

# Structure Analysis
This time, I planned to place both DN42 and clearnet BGP routes into the system's main routing table, then separate them for export using filters to distinguish which should be exported. For clarity, I stored the configuration for the DN42 part and the clearnet part (hereinafter referred to as inet) separately, and then included them from the main configuration file. Also, since there should ideally only be one kernel configuration per routing table, I merged the DN42 and inet kernel parts, keeping only one instance.  

After multiple optimizations and revisions, my final directory structure is as follows:  
```text
/etc/bird/
├─envvars
├─bird.conf: Main Bird config file, defines basic info (ASN, IP, etc.), includes sub-configs below
├─kernel.conf: Kernel config, imports routes into the system routing table
├─dn42
|  ├─defs.conf: DN42 function definitions, e.g., is_self_dn42_net()
|  ├─ibgp.conf: DN42 iBGP template
|  ├─rpki.conf: DN42 RPKI route validation
|  ├─ospf.conf: DN42 OSPF internal network
|  ├─static.conf: DN42 static routes
|  ├─ebgp.conf: DN42 Peer template
|  ├─ibgp
|  |  └<ibgp configs>: DN42 iBGP configs for each node
|  ├─ospf
|  |  └backbone.conf: OSPF area
|  ├─peers
|  |  └<ibgp configs>: DN42 Peer configs for each node
├─inet
|  ├─peer.conf: Clearnet Peer
|  ├─ixp.conf: Clearnet IXP connection
|  ├─defs.conf: Clearnet function definitions, e.g., is_self_inet_v6()
|  ├─upstream.conf: Clearnet upstream
|  └static.conf: Clearnet static routes
```

I separated the function definitions because I needed to reference them in the filters within `kernel.conf`, so I isolated them for early inclusion.  

After filling in the respective configurations and setting up the include relationships, I ran `birdc configure` and it started successfully. So, case closed... right?

# Problems occurred
After running for a while, I suddenly found that I couldn't ping the HKG node from my internal devices, nor could I ping my other internal nodes from the HKG node. Strangely, external ASes could ping my other nodes or other external ASes through my HKG node, and my internal nodes could also ping other non-directly connected nodes (e.g., 226(NKG)->225(HKG)->229(LAX)) via the HKG node.  
Using `ip route get <other internal node address>` revealed:
```shell
root@iYoRoyNetworkHKG:/etc/bird# ip route get 172.20.234.226
172.20.234.226 via 172.20.234.226 dev dn42_nkg src 23.149.120.51 uid 0
    cache
```
See the problem? The src address should have been the HKG node's own DN42 address (configured on the OSPF stub interface), but here it showed the HKG node's clearnet address instead.  
Attempting to read the route learned by Bird using `birdc s r for 172.20.234.226`:
```shell
root@iYoRoyNetworkHKGBGP:/etc/bird/dn42/ospf# birdc s r for 172.20.234.226
BIRD 2.17.1 ready.
Table master4:
172.20.234.226/32    unicast [dn42_ospf_iyoroynet_v4 00:30:29.307] * I (150/50) [172.20.234.226]
        via 172.20.234.226 on dn42_nkg onlink
```
Looks seemingly normal...?  
Theoretically, although the DN42 source IP is different from the usual, DN42 rewrites `krt_prefsrc` when exporting to the kernel to inform the kernel of the correct source address, so this issue shouldn't occur:
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

* Regarding `krt_prefsrc`, it stands for **Kernel Route Preferred Source**. This attribute doesn't manipulate the route directly but instead attaches a piece of **metadata** to it. **This metadata directly instructs the Linux kernel to prioritize the specified IP address as the source address for packets sent via this route**.

I was stuck on this for a long time.

# The Solution
Finally, during an unintentional attempt, I added the `krt_prefsrc` rewrite to the OSPF import configuration as well:
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
After running this, the src address became correct, and mutual pinging worked.  

---
Configuration files for reference: [KaguraiYoRoy/Bird2-Configuration](https://github.com/KaguraiYoRoy/Bird2-Configuration/tree/main/hkg-cn)