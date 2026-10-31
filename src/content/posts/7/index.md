---
title: "记一次为Android 4.9内核的ROM启用erofs支持"
published: 2024-12-25T15:26:00.000Z
updated: 2025-11-05T14:26:49.000Z
description: "为Android 4.9内核的ROM启用erofs支持"
image: ""
tags: ["Android", "AOSP", "Kernel"]
category: "Android"
categories: ["Android", "开发"]
draft: false
lang: "zh_CN"
---

# 前言
~~众所周知，咱是老牌小米8屏幕指纹版钉子户了~~  
咱一直想给这个机子上个erofs（关于erofs是什么请自行搜索  
但是经过查阅得知erofs是在5.10被加入到Linux内核中的，也就是说咱4.9得手动集成  

# 准备材料
* Android ROM源码：这里使用的是LineageOS 22.0
* Android Kernel源码：这里咱用的是LineageOS官方小米845内核：[LineageOS/android_kernel_xiaomi_sdm845](https://github.com/LineageOS/android_kernel_xiaomi_sdm845)
* 设备树：这里使用的是LineageOS官方设备树，包含sdm845-common部分（[LineageOS/android_device_xiaomi_sdm845-common](https://github.com/LineageOS/android_device_xiaomi_sdm845-common)）和device-specific部分（[LineageOS/android_device_xiaomi_equuleus](https://github.com/LineageOS/android_device_xiaomi_equuleus)）
* 编译服务器

:::note
注：因为咱主要是玩编译的比较多，因此这篇主要阐述的是编译ROM过程中的折腾记录
:::

# 开整
部署Android ROM编译环境就不说了，网上一搜一大片，把ROM源码、设备树、内核源码下载下来放到对应位置

## 为内核添加erofs支持
此处代码pick from ReallySnow的msm-4.9内核（谢谢ReallySnow大佬的支持！），可参考如下分支：

* https://github.com/ReallySnow/msm-4.9/tree/erofs
* https://github.com/YoriInstitute/android_kernel_xiaomi_sdm845/tree/lineage-22.0-erofs  

pick之前要先处理lz4压缩部分代码的冲突。详细Relation chain可参考：
* https://review.lineageos.org/c/LineageOS/android_kernel_xiaomi_sdm845/+/412614    

~~_咱尝试将改造提交给LineageOS官方但是很显然没被合并x_~~

pick完更改后在内核的defconfig文件中开启erofs支持：  
打开`$KERNEL_SOURCE/arch/arm64/configs/vendor/xiaomi/mi845_defconfig`并添加：`CONFIG_EROFS_FS=y`：
```diff
commit 7ae5caab2c15982b3d3821c97e2f2e6126ca1281 (HEAD -> erofs, refs/published/erofs)
Author: KaguraiYoRoy <neko@yori.moe>
Date:   Tue Dec 24 22:49:07 2024 +0800

    arch: arm64: configs: mi845: Enable CONFIG_EROFS_FS

    Change-Id: Ie387b03bde54700d73ccf19f0baf4db62526cc8f

diff --git a/arch/arm64/configs/vendor/xiaomi/mi845_defconfig b/arch/arm64/configs/vendor/xiaomi/mi845_defconfig
index 7684be360d98..69ea580fdb11 100644
--- a/arch/arm64/configs/vendor/xiaomi/mi845_defconfig
+++ b/arch/arm64/configs/vendor/xiaomi/mi845_defconfig
@@ -651,3 +651,4 @@ CONFIG_SOUNDWIRE_WCD_CTRL=y
 CONFIG_WCD9XXX_CODEC_CORE=y
 CONFIG_WCD_DSP_GLINK=y
 CONFIG_WCD_SPI_AC=y
+CONFIG_EROFS_FS=y
\ No newline at end of file
```

## 修改分区文件系统和fstab
打开设备树中板级配置文件把要改为erofs的分区的文件系统改为`erofs`，示例中的配置文件在`$WORKING_DIR/device/xiaomi/sdm845-common/BoardConfigCommon.mk`：
```diff
commit 0fce86fb40ca637a8563bef6192afaea1658c881 (HEAD -> erofs, refs/published/erofs)
Author: KaguraiYoRoy <neko@yori.moe>
Date:   Tue Dec 24 23:37:50 2024 +0800

    sdm845-common: Switch to erofs

    Change-Id: I9a8d6de4dcb79cd6bc177451ce3cbc4682748501

diff --git a/BoardConfigCommon.mk b/BoardConfigCommon.mk
index cf73d39..700592f 100644
--- a/BoardConfigCommon.mk
+++ b/BoardConfigCommon.mk
@@ -78,11 +78,11 @@ BOARD_CACHEIMAGE_PARTITION_SIZE := 268435456
 BOARD_USERDATAIMAGE_PARTITION_SIZE := 57453555712

 BOARD_CACHEIMAGE_FILE_SYSTEM_TYPE := ext4
-BOARD_ODMIMAGE_FILE_SYSTEM_TYPE := ext4
+BOARD_ODMIMAGE_FILE_SYSTEM_TYPE := erofs
 BOARD_PRODUCTIMAGE_FILE_SYSTEM_TYPE := ext4
 BOARD_SYSTEMIMAGE_FILE_SYSTEM_TYPE := ext4
 BOARD_SYSTEM_EXTIMAGE_FILE_SYSTEM_TYPE := ext4
-BOARD_VENDORIMAGE_FILE_SYSTEM_TYPE := ext4
+BOARD_VENDORIMAGE_FILE_SYSTEM_TYPE := erofs

 BOARD_FLASH_BLOCK_SIZE := 262144 # (BOARD_KERNEL_PAGESIZE * 64)

```

修改机器fstab文件，此处在`$WORKING_DIR/device/xiaomi/equuleus/rootdir/fstab.qcom`，将挂载文件系统改为`erofs`，挂载参数仅保留一个`ro`即可：
```diff
commit d66bfc8fe722f7368ef56835d35fb88b904e10fb (HEAD -> erofs, refs/published/erofs)
Author: KaguraiYoRoy <neko@yori.moe>
Date:   Tue Dec 24 23:40:08 2024 +0800

    equuleus: Update fstab for erofs

    Change-Id: I814eab1dd77cf2c184ebd398cc4914785bc37ad6

diff --git a/rootdir/etc/fstab.qcom b/rootdir/etc/fstab.qcom
index 7aca90a..685ec84 100644
--- a/rootdir/etc/fstab.qcom
+++ b/rootdir/etc/fstab.qcom
@@ -6,8 +6,8 @@
 system                                       /system                 ext4    ro,barrier=1,discard                                                                              wait,logical,first_stage_mount
 system_ext                                   /system_ext             ext4    ro,barrier=1,discard                                                                              wait,logical,first_stage_mount
 product                                      /product                ext4    ro,barrier=1,discard                                                                              wait,logical,first_stage_mount
-vendor                                       /vendor                 ext4    ro,barrier=1,discard                                                                              wait,logical,first_stage_mount
-odm                                          /odm                    ext4    ro,barrier=1,discard                                                                              wait,logical,first_stage_mount
+vendor                                       /vendor                 erofs   ro                                                                                                wait,logical,first_stage_mount
+odm                                          /odm                    erofs   ro                                                                                                wait,logical,first_stage_mount
 /dev/block/bootdevice/by-name/userdata       /data                   ext4    noatime,nosuid,nodev,barrier=0,noauto_da_alloc                                                    latemount,wait,check,fileencryption=ice,quota
 /dev/block/bootdevice/by-name/modem          /vendor/firmware_mnt    vfat    ro,shortname=lower,uid=0,gid=1000,dmask=227,fmask=337,context=u:object_r:firmware_file:s0         wait
 /dev/block/bootdevice/by-name/dsp            /vendor/dsp             ext4    ro,nosuid,nodev,barrier=1                                                                         wait
```
最后编译并刷入，如果不出意外的话就能启动进系统了。

## 特别注意
* LineageOS官方对我这款机型做了动态分区改造，上述设备树的修改可能并不适用于你的机型
* erofs为**只读文件系统**，如果后期要刷Gapps，**请勿改造**`system`、`system_ext`、`product`这三个分区

# 常见问题
* 开机进入fastboot：检查fstab是否修改正确
