---
title: "Enabling EROFS Support for an Android ROM with Kernel 4.9"
published: 2024-12-25T15:26:00.000Z
updated: 2025-11-05T14:28:48.000Z
description: "Backporting EROFS to the Xiaomi Mi 8 Pro's Linux 4.9 kernel, updating the LineageOS device tree and fstab, and troubleshooting build and boot issues."
image: ""
tags: ["Android", "AOSP", "Kernel"]
category: "Android"
categories: ["Android", "Develop"]
draft: false
lang: "en_US"
---

# Foreword
~~As everyone knows, I'm a long-standing Mi 8 Pro (Under-Screen Fingerprint Edition) holdout~~  
I've always wanted to port erofs to this device (please search online for what erofs is).
But after some research, I found out that erofs was merged into the Linux kernel in version 5.10, which means I have to manually integrate it into our 4.9 kernel.

# Materials Needed
* Android ROM Source Code: Using LineageOS 22.0 here.
* Android Kernel Source Code: Using the official LineageOS kernel for Xiaomi SDM845 devices: [LineageOS/android_kernel_xiaomi_sdm845](https://github.com/LineageOS/android_kernel_xiaomi_sdm845)
* Device Tree: Using the official LineageOS device trees, which include the sdm845-common part: [LineageOS/android_device_xiaomi_sdm845-common](https://github.com/LineageOS/android_device_xiaomi_sdm845-common) and the device-specific part: [LineageOS/android_device_xiaomi_equuleus](https://github.com/LineageOS/android_device_xiaomi_equuleus)
* A build server

:::note
Note: Since I'm primarily focused on ROM building, this article mainly documents the process within that context.
:::

# Let's Start
Setting up the Android ROM build environment won't be covered here, as there are plenty of guides online. Download the ROM source, device tree, and kernel source, and place them in the correct locations.

## Adding EROFS Support to the Kernel
The code changes were picked from ReallySnow's msm-4.9 kernel (Thanks to ReallySnow for the support!). You can refer to these branches:  

* https://github.com/ReallySnow/msm-4.9/tree/erofs
* https://github.com/YoriInstitute/android_kernel_xiaomi_sdm845/tree/lineage-22.0-erofs  

Before picking the commits, you need to resolve conflicts in the lz4 compression code. For the detailed relation chain, refer to:  
* https://review.lineageos.org/c/LineageOS/android_kernel_xiaomi_sdm845/+/412614    

~~_I tried to submit these changes to LineageOS official, but obviously, they weren't merged x_~~

After picking the changes, enable erofs support in the kernel's defconfig file:  
Open `$KERNEL_SOURCE/arch/arm64/configs/vendor/xiaomi/mi845_defconfig` and add: `CONFIG_EROFS_FS=y`:
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

## Modifying Partition Filesystems and Fstab
Open the board configuration file in the device tree and change the filesystem type for the partitions you want to convert to `erofs`. The example configuration file is located at `$WORKING_DIR/device/xiaomi/sdm845-common/BoardConfigCommon.mk`:  
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

Modify the device's fstab file, located here at `$WORKING_DIR/device/xiaomi/equuleus/rootdir/fstab.qcom`. Change the filesystem type for the relevant partitions to `erofs`, and reduce the mount parameters to just `ro`:  
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
Finally, build and flash the ROM. If all goes well, it should boot into the system.  

## Important Notes
* LineageOS official has implemented Dynamic Partition for my device model. The device tree modifications described above might not be suitable for your device.
* erofs is a **read-only filesystem**. If you plan to flash Gapps later, **DO NOT convert** the `system`, `system_ext`, and `product` partitions.

# Frequently Asked Questions
* Booting into Fastboot mode: Check if the fstab modifications are correct.
