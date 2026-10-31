---
title: "在TrueNAS上使用Docker安装1Panel"
published: 2025-03-07T05:18:00.000Z
updated: 2025-06-27T03:29:09.000Z
description: "在TrueNAS上使用Docker安装1Panel"
image: "./images/2025/03/3758994431.jpg"
tags: ["Linux", "TrueNAS", "Docker", "Web", "1Panel"]
category: "NAS"
draft: false
lang: "zh_CN"
---

# 背景
家里TrueNAS性能剩余，想着部署个web服务。想要装个面板减少点工作量，又考虑到虚拟机性能折损和zfs cache对内存的要求比较大以及NAS本身性能也不好，便打算使用docker部署。再加上1Panel本身也是以docker为介质，二者共同控制TrueNAS宿主机的docker daemon，约等于直接将网站部署到TrueNAS本地并且也便于管理。

# 分析

:::warning
本文默认TrueNAS可以访问dockerhub并且已经配置好了docker daemon
:::

## 环境信息
### Storage Pool

存在两个存储池:

1. `/mnt/data`: 1 x MIRROR | 2 wide | 2.73 TiB | HDD
2. `/mnt/systemdata`: 1 x DISK | 1 wide | 223.57 GiB | SSD

其中docker数据存储在2号存储池中。

### Datasets

存在三个数据集:

1. Storage: 位于data存储池，存放冷数据
2. DockerData: 位于systemdata存储池，存放容器的持久化存储文件
3. KaguraiYoRoy: 位于systemdata，用户home文件夹

## 安装1Panel

使用了**moelin/1panel:latest**镜像部署，此步骤很多部分都可以参考镜像作者写的README。项目地址：
::github{repo="okxlin/docker-1panel"}

在DockerData数据集创建了一个文件夹专门用于存储1panel数据，即用作容器内`/opt/1panel`，位于`/mnt/systemdata/DockerData/1panel`。  

### 持久卷

* 因为要允许1Panel管理宿主机docker，因此需要映射`/var/run/docker.sock`和宿主的docker文件夹
* 映射上文为其创建的数据文件夹

TrueNAS的docker文件夹和一般的Linux位置不一样，一般的Linux位于`/var/lib/docker`而TrueNAS的位于`/mnt/.ix-apps/docker`。  

### 环境变量和端口映射

环境变量和镜像作者的设置相同，传入`TZ=Asia/Shanghai`；端口映射根据需要自行设置即可，容器内端口为**10086**。  

### Docker Compose

有了上述信息，编写docker compose就容易许多了。  
完整Docker Compose文件如下：
```yaml
services:
  1panel:
    dns:
      - 223.5.5.5
    environment:
      - TZ=Asia/Shanghai
    image: moelin/1panel:latest
    labels:
      createdBy: Apps
    ports:
      - '8085:10086'
    restart: always
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - /mnt/.ix-apps/docker:/var/lib/docker
      - /mnt/systemdata/DockerData/1panel/opt:/opt/1panel
      - /mnt/systemdata/DockerData/1panel/root:/root
      - /etc/docker:/etc/docker
```

这里映射`/root`是因为我需要在容器内运行Git，而Git config存储在/root下；  
设置dns是因为1Panel制作环境镜像的时候需要连网下载数据，不指定dns会报错。  

安装完成后访问你设置的端口即可。  

1Panel基础信息:  
- 默认账户：`1panel`
- 默认密码：`1panel_password`
- 默认入口：`entrance`

*****

# 故障处理
## Docker镜像源

实际测试的时候发现如果不设置镜像源，即使配置了Proxy，在安装PHP环境的时候也会报错~~，并且配置了镜像源同时配置了Proxy也会安装失败，不清楚为什么~~  
打开TrueNAS的`/etc/docker/daemon.json`并添加registry-mirrors：  
```json
{
	"data-root": "/mnt/.ix-apps/docker",
	"default-address-pools": [
		{
			"base": "172.17.0.0/12",
			"size": 24
		}
	],
	"exec-opts": [
		"native.cgroupdriver=cgroupfs"
	],
	"iptables": true,
	"registry-mirrors": [
		"https://docker.1panel.live"
	],
	"storage-driver": "overlay2"
}
```

保存，重启主机docker，再去1Panel里安装环境。  

:::warning
这一步的配置重启后会丢失，尽量一次性安装好环境和需要的app
:::

## 1Panel创建的容器无法启动

这个是因为在1Panel中，默认存储数据的文件夹是我们所映射出来的`/opt/1panel`，但是实际上创建的容器运行在TrueNAS里，访问的是TrueNAS里不存在的`/opt/1panel`，并且其/opt默认是只读的，因此在启动容器的时候会报错Read-only filesystem。  

我自己的解决方案也很简单粗暴，在TrueNAS主机中先挂载/opt为可读写，再创建一个软链接指向1Panel的数据文件夹。

```bash
cd /opt
mount -o remount,rw /opt
ln -s /mnt/systemdata/DockerData/1panel/opt 1panel
```

然后就可以正常使用啦  

有一个需要注意的点，在1Panel中安装OpenResty时记得避开使用80和443端口，这俩是TrueNAS的webui默认端口