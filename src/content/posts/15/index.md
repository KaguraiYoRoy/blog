---
title: "为黑群晖迁移RR引导盘"
published: 2025-01-29T16:36:00.000Z
updated: 2025-06-27T03:29:28.000Z
description: "为黑群晖迁移RR引导盘"
image: "./images/2025/01/760705903.jpg"
tags: ["Linux", "群晖"]
category: "NAS"
categories: ["NAS"]
draft: false
lang: "zh_CN"
---

写这篇文章是因为原来的磁盘是一个16g的u盘，目标磁盘是一条16g的傲腾，虽然都是16G但是原先那个稍微大一点（我也不知道为什么（逃  
直接dd肯定是行不通了，原盘比目标盘大，故记录下折腾过程


:::warning
数据无价，折腾需谨慎
:::

# 分析
RR引导盘一共有三个分区：  
1. FAT32,50.00MB
2. Ext2,50.00MB
3. Ext4,剩余所有空间  

其中，第一个分区是引导分区，是可引导的（`fdisk -l`中Boot被打了星号）；第二个没研究是什么，估计是grub，第三个存放了群晖的内核和RR的配置文件  

# 思路
因为前两个分区大小很小，所以直接用dd将两个分区完整拷贝到目标磁盘；第三个分区手动创建并格式化后将UUID、Label同步过来  


:::warning
折腾过程使用Linux操作
:::

# 开整
将两块磁盘接入系统，分别为原盘`/dev/sda`，目标盘`/dev/sdb`  
查看原盘信息：
```bash
sudo fdisk -l /dev/sda
```
输出：
```text
Disk /dev/sda: 14.55 GiB, 15627976704 bytes, 30523392 sectors
Disk model: Storage Media   
Units: sectors of 1 * 512 = 512 bytes
Sector size (logical/physical): 512 bytes / 512 bytes
I/O size (minimum/optimal): 512 bytes / 512 bytes
Disklabel type: dos
Disk identifier: 0x66d0fe82

Device     Boot  Start      End  Sectors  Size Id Type
/dev/sda1  *      2048   104447   102400   50M 83 Linux
/dev/sda2       104448   206847   102400   50M 83 Linux
/dev/sda3       206848 30523391 30316544 14.5G 83 Linux
```

## 将前两个分区和磁盘分区表信息拷贝到目标盘
```bash
sudo dd if=/dev/sda of=dev/sdb count=206848 # 此处count的数值为上面第三个分区的起始请根据你的磁盘修改
```
输出：
```text
206848+0 records in
206848+0 records out
105906176 bytes (106 MB, 101 MiB) copied, 11.3812 s, 9.3 MB/s
```
## 创建第三个分区
使用fdisk打开磁盘：
```bash
sudo fdisk /dev/sdb
```
先删除原有的第三个分区的分区数据：输入`d`，输出`Partition number (1-3, default 3):`时输入3或直接回车；  
提示`Partition 3 has been deleted.`后输入`n`创建分区，`Partition type`选择主分区，即`p`，剩下一路默认回车即可。完成后输入`w`保存退出。  
不会用fdisk的建议自行搜索  

# 格式化新创建的分区并写入UUID等信息
```bash
sudo mkfs.ext4 /dev/sdb3
```

使用file指令查看原盘第三个分区的信息：
```bash
sudo file -s /dev/sda3
```
输出：
```text
/dev/sda3: Linux rev 1.0 ext4 filesystem data, UUID=617a3aca-4b56-42d7-8558-54411b344a7d, volume name "RR3" (extents) (64bit) (large files) (huge files)
```
记录下`UUID`和`volume name`（即"RR3"），并使用如下指令将UUID和volume name写入新盘：
```bash
sudo tune2fs /dev/sdb3 -U df39b1f3-b846-49dc-a317-ce329ec87ca2 # 写入UUID
sudo tune2fs /dev/sdb3 -L RR3 # 写入volume name
```

# 拷贝数据
挂载两个盘的第三分区，假设原盘为`~/a`，目标盘为`~/b`，接着拷贝`a`中的所有数据到`b`（这步直接cp指令就行，不多赘述了）

最终，umount所有挂载点，拔下磁盘接入黑群晖，迁移成功。
