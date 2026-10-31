---
title: "使用家宽无公网IP+CDNfly实现建站"
published: 2025-03-09T06:33:00.000Z
updated: 2025-06-27T03:28:50.000Z
description: "使用家宽无公网IP+CDNfly实现建站"
image: ""
tags: []
category: "运维"
categories: ["运维"]
draft: false
lang: "zh_CN"
---

# 前言
~~众所周知~~家宽建站一般需要有公网IP，但实际上没有公网IP时的某些情况通过特殊手段也可以实现在运营商的出口IP上公开一个端口用于外部对内连接的http端口，即NAT穿透（和FRP、ngrok、花生壳这样的内网穿透不一样，这种穿透不需要服务端）

# 前置条件
下载[NatTypeTester](https://github.com/HMBSbige/NatTypeTester/)，检测本机的NAT类型。关于NAT类型是什么请自行查阅资料。  

请确保你的网络环境满足如下条件：
1. RFC3489下的NAT类型需为**Full Cone**
2. RFC5780下的TCP的映射行为需要是**EndpointIndependent**

如果出现UDPBlocked请更换服务器

## 提升NAT类型的办法
1. 减少路由层数，光猫拨号的尽量直接将设备接在光猫下，多层路由的尽量将设备直接接在最顶上那层路由下
2. 开启路由器的UPnP
3. 设置DMZ主机为服务器IP

# 开始
使用了[Lucky](http://lucky666.cn/)作为NAT穿透的工具，通过Docker Compose部署在TrueNAS上，TrueNAS本地的9080开放了HTTP端口。  

部署Web服务器不在本文论述的范围内。  

## 安装Lucky
按照官网介绍，编写DockerCompose：
```yaml
services:
  lucky:
    image: gdy666/lucky
    network_mode: host
    restart: always
    volumes:
      - /mnt/systemdata/DockerData/lucky/luckyconf:/goodluck
```
请修改持久化存储路径为你自己的路径。  
其中`network_mode`需要为**host**，当然不是host也可以部署，但是不在本文讨论范围内。  

安装完成后打开**http://[YourIP]:16601**，默认账号666默认密码666。登录后按照要求修改安全设置。  

## 配置穿透
打开Lucky页面左侧的**STUN内网穿透**，并创建穿透规则。  
穿透本地端口填写一任意端口（注意不要和本机的服务冲突），目标地址和端口填写内网下的Web服务所在IP和端口。  

**完成上述配置后以下几种穿透方式请任选一种**



### NAT-PMP方式

开启路由器UPnP功能，打开STUN穿透的NAT-PMP开关，NAT-PMP网关地址填入路由器地址即可。  



### DMZ主机方式

在路由器DMZ主机设置将Lucky所在服务器IP设置为DMZ主机，然后关闭STUN穿透的UPnP、NAT-PMP选项。



### 非Docker安装+UPnP

开启路由器UPnP功能，打开STUN穿透的UPnP开关，UPnP网关IP填写路由器IP，UPnP客户端本地IP填写Lucky所在主机IP，其他留空。 



### Docker安装+UPnP

需要先在非Docker的环境下运行一次Lucky以获取UPnP接口地址。比如我在电脑（Windows）上安装Lucky并创建一条测试隧道，填写内容和上文非Docker安装相同，目标地址和目标端口可随意填写。开启穿透后在日志里能看到类似如下内容：  
```text
UPNP===>Control URL: http://192.168.3.1:5351/ctl/IPCon
```
（这里的URL是我的小米路由器AX3600的UPnP管理地址，不同路由器不一样）  

复制这里的Control URL，再在Docker内的Lucky中将Control URL填写到**UPnP控制接口地址**一项中并开启穿透即可。  




如果不出问题应该能看到运营商的公网出口所分配的地址和端口，若能够从外面访问或者itdog测速能绿就代表穿透成功了。  

## 配置CDNfly的WebHook
因为这种方式获得的公网IP和端口都是动态的，因此需要类似于DDNS的服务来固定访问方式，可以使用CloudFlare Workers进行重定向，也可以使用CDN动态修改回源IP和端口。我使用的是后面那种方式。  

我的CDN使用的是cdnfly管理系统，查阅cdnfly的官方文档可以找到API请求方式。

在编辑STUN内网穿透规则时下面打开Webhook并勾选**仅在地址和上一次不同时触发Webhook**，接口地址填入cdn网站管理API地址：`https://[your-cdn-domain]/v1/sites`，请求方法**PUT**；请求头标填入api-key和api-secret（可以在CDNfly后台看到）：
```text
api-key: Your API Key
api-secret: Your API Secret
```

请求体用json格式按照cdnfly官方文档的请求方式构建payload（请将id字段改成你的网站id，若存在多个网站则按照如下格式多复制几个并修改对应id即可）：
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

其中，`#{ip}`和`#{port}`是Lucky提供的参数，标识获取到的公网IP和端口。  

保存，不出意外的话会自动将CDN对应网站的回源地址和端口改成运营商公网IP和端口。

## 安全问题
我本人建议使用HTTPS穿透，毕竟HTTP是明文传输，安全性还是不能保证。如果使用HTTPS，需要将上文CDN API调用的Payload中`backend_http_port`改成`backend_https_port`并在CDN处改为使用HTTPS回源。

*****

参考文章：
* https://doc.cdnfly.cn/wangzhanguanli-v1-sites.html
* https://lucky666.cn/docs/intro
* https://www.bilibili.com/opus/971100369193009187
* https://github.com/gdy666/lucky