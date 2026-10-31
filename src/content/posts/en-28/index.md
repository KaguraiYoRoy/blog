---
title: "Installing 1Panel Using Docker on TrueNAS"
published: 2025-03-07T05:18:00.000Z
updated: 2025-11-09T15:03:30.000Z
description: "Running 1Panel in Docker on TrueNAS to manage the host's Docker service, with notes on directory mappings, registry mirrors, and container startup failures."
image: ""
tags: ["Linux", "TrueNAS", "Docker", "Web", "1Panel"]
category: "NAS"
categories: ["NAS"]
draft: false
lang: "en_US"
---

# Background
My TrueNAS has some performance headroom, so I'm thinking of deploying a web service. I want to install a control panel to reduce manual work. Considering the performance overhead of virtual machines, the high memory requirements for ZFS cache, and the fact that the NAS itself isn't very powerful, I decided to use Docker for deployment. Furthermore, since 1Panel itself is distributed as a Docker image, both systems controlling the TrueNAS host's Docker daemon is essentially equivalent to deploying websites directly on the TrueNAS host, making management easier.

# Analysis
:::warning
This article assumes TrueNAS can access Docker Hub and the Docker daemon is already configured.
:::

## Environment Information
### Storage Pool
There are two storage pools:

1. `/mnt/data`: 1 x MIRROR | 2 wide | 2.73 TiB | HDD
2. `/mnt/systemdata`: 1 x DISK | 1 wide | 223.57 GiB | SSD

Docker data is stored in storage pool #2.

### Datasets

There are three datasets:
* Storage: Located in the `data` storage pool, stores cold data.
* DockerData: Located in the `systemdata` storage pool, stores persistent data for containers.
* KaguraiYoRoy: Located in `systemdata`, the user's home directory.

## Installing 1Panel

Used the **moelin/1panel:latest** image for deployment. Many parts of this process can refer to the README written by the image author. Project address: [okxlin/docker-1panel](https://github.com/okxlin/docker-1panel)  

Created a folder specifically for storing 1Panel data within the DockerData dataset, which is used as `/opt/1panel` inside the container, located at `/mnt/systemdata/DockerData/1panel`.

### Persistent Volumes

* To allow 1Panel to manage the host's Docker, map `/var/run/docker.sock` and the host's Docker directory.
* Map the data folder created for it earlier.

The Docker directory in TrueNAS is different from typical Linux systems. Typically, it's at `/var/lib/docker`, but in TrueNAS, it's at `/mnt/.ix-apps/docker`.  

### Environment Variables and Port Mapping
The environment variables are the same as those set by the image author, passing `TZ=Asia/Shanghai`. Port mapping can be set as needed; the container's port is **10086**.

### Docker Compose
With the above information, writing the Docker Compose file becomes straightforward.  
The complete Docker Compose file is as follows:  
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

Mapping `/root` is because I need to run Git inside the container, and Git config is stored under /root.  
Setting DNS is because 1Panel needs to download data online when building environment images, and errors occur without specifying DNS.

After installation, access the port you set.

1Panel Basic Information:
- Default Username: `1panel`
- Default Password: `1panel_password`
- Default Entrance: `entrance`

*****

# Troubleshooting
## Docker Mirror

During testing, it was found that without setting a mirror source, even with a Proxy configured, installing the PHP environment would fail. ~~Furthermore, configuring both a mirror source and a Proxy also led to installation failure; the reason is unclear.~~
Open `/etc/docker/daemon.json` on TrueNAS and add registry-mirrors:
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

Save the file, restart the host's Docker service, then try installing the environment in 1Panel again.

:::warning
This configuration might be lost after a reboot. Try to install all necessary environments and apps in one go if possible.
:::

## Containers Created by 1Panel Fail to Start
This is because in 1Panel, the default folder for storing data is the mapped `/opt/1panel`. However, the containers actually run on the TrueNAS host and try to access `/opt/1panel`, which doesn't exist on TrueNAS by default, and its `/opt` is read-only by default. This causes a "Read-only filesystem" error when starting containers.

My solution is straightforward: On the TrueNAS host, first remount /opt as read-write, then create a symbolic link pointing to 1Panel's data folder.

```bash
cd /opt
mount -o remount,rw /opt
ln -s /mnt/systemdata/DockerData/1panel/opt 1panel
```

After this, it should work normally.

One thing to note: When installing OpenResty in 1Panel, remember to avoid using ports 80 and 443, as these are the default ports for the TrueNAS web UI.