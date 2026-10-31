---
title: "Using Home Broadband without Public IP + CDNfly to Host a Website"
published: 2025-03-09T06:33:00.000Z
updated: 2025-11-22T04:01:34.000Z
description: "Learn how to host a website using home broadband without a public IP by implementing NAT penetration with Lucky and dynamically updating CDNfly for origin IP and port changes. A step-by-step guide for setting up secure web hosting with dynamic IP handling.\r\n\r\n"
image: ""
tags: []
category: "Ops"
categories: ["Ops"]
draft: false
lang: "en_US"
---

# Introduction
~~As is well known~~, hosting a website with home broadband usually requires a public IP address. However, in certain cases without a public IP, it is possible to expose an HTTP port on the carrier's exit IP for external connections through special methods, i.e., NAT penetration (this is different from FRP, ngrok, or Oray-like intranet penetration, as it does not require a server).

# Prerequisites
Download [NatTypeTester](https://github.com/HMBSbige/NatTypeTester/) to check your NAT type. Please refer to relevant materials for details on NAT types.

Ensure your network environment meets the following conditions:
1. Under RFC3489, the NAT type must be **Full Cone**.
2. Under RFC5780, the TCP mapping behavior must be **EndpointIndependent**.

If UDPBlocked appears, change the server.

## Methods to Improve NAT Type
1. Reduce the number of router layers. If using modem dial-up, connect the device directly under the modem. For multi-layer routing, connect the device directly under the top router.
2. Enable UPnP on the router.
3. Set the DMZ host to the server IP.

# Getting Started
We use [Lucky](http://lucky666.cn/) as the NAT penetration tool, deployed on TrueNAS via Docker Compose. TrueNAS locally has port 9080 open for HTTP.

Deploying a web server is not covered in this article.  

## Installing Lucky
Follow the official guide and write a Docker Compose file: 
```yaml
services:
  lucky:
    image: gdy666/lucky
    network_mode: host
    restart: always
    volumes:
      - /mnt/systemdata/DockerData/lucky/luckyconf:/goodluck
```
Modify the persistent storage path to your own.
Note: `network_mode` must be **host**. It can be deployed without host, but that is not discussed here.

After installation, open `http://[YourIP]:16601`. The default username is 666 and password is 666. After logging in, modify security settings as required.

## Configuring Penetration
Open **STUN Intranet Penetration** on the left side of the Lucky page and create a penetration rule.  
Fill in the local port with any port (ensure it does not conflict with local services), and the target address and port with the IP and port of the web service on the intranet.

**After completing the above configuration, choose one of the following penetration methods:**



### NAT-PMP Method

Enable the router's UPnP function, turn on the NAT-PMP switch in STUN penetration, and fill in the router address as the NAT-PMP gateway address.



### DMZ Host Method

Set the server IP where Lucky is installed as the DMZ host in the router's DMZ settings, then turn off the UPnP and NAT-PMP options in STUN penetration.



### Non-Docker Installation + UPnP

Enable the router's UPnP function, turn on the UPnP switch in STUN penetration, fill in the router IP as the UPnP gateway IP, and fill in the Lucky host IP as the UPnP client local IP, leaving others blank.



### Docker Installation + UPnP

First, run Lucky in a non-Docker environment to obtain the UPnP interface address. For example, install Lucky on a computer (Windows) and create a test tunnel with the same content as the non-Docker installation. The target address and port can be filled arbitrarily. After enabling penetration, you might see content like this in the log:
```text
UPNP===>Control URL: http://192.168.3.1:5351/ctl/IPCon
```
(Here, the URL is my Xiaomi router AX3600's UPnP management address; different routers may vary.)

Copy the Control URL, then fill it into the **UPnP Control Interface Address** in the Docker Lucky and enable penetration.




If no issues arise, you should see the address and port assigned by the carrier's public exit IP. If you can access it from outside or if an itdog test shows green, the penetration is successful.

## Configuring CDNfly WebHook
Since the public IP and port obtained this way are dynamic, a service similar to DDNS is needed to fix the access method. You can use CloudFlare Workers for redirection or use a CDN to dynamically modify the origin IP and port. I use the latter.  

My CDN uses the cdnfly management system. Refer to the cdnfly official documentation for API request methods.  

When editing the STUN intranet penetration rule, open Webhook below and check **Only trigger Webhook when the address is different from the last time**. Fill in the API address: `https://[your-cdn-domain]/v1/sites`, request method **PUT**; request headers include api-key and api-secret (can be found in the CDNfly backend):
```text
api-key: Your API Key
api-secret: Your API Secret
```

The request body uses JSON format to construct the payload according to the cdnfly official documentation (change the id field to your website id; if multiple websites, copy and modify accordingly):  
```json
[
    {
        "id": 114,
        "backend_http_port": #{port},
        "backend": [
            {
                "addr": "#{ip}",
                "weight": 1,
                "state": "up"
            }
        ]
    },
    {
        "id": 514,
        "backend_http_port": #{port},
        "backend": [
            {
                "addr": "#{ip}",
                "weight": 1,
                "state": "up"
            }
        ]
    }
]
```

Where `#{ip}` and `#{port}` are parameters provided by Lucky, representing the obtained public IP and port. 

Save, and if no issues, the CDN's corresponding website's origin address and port will be automatically changed to the carrier's public IP and port.  

## Security Considerations
I recommend using HTTPS penetration because HTTP is plain text and less secure. If using HTTPS, change `backend_http_port` to `backend_https_port` in the CDN API call payload and switch to HTTPS origin in the CDN.

----

Reference Articles:
* https://doc.cdnfly.cn/wangzhanguanli-v1-sites.html
* https://lucky666.cn/docs/intro
* https://www.bilibili.com/opus/971100369193009187
* https://github.com/gdy666/lucky