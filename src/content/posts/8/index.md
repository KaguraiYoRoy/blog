---
title: "给Android 4.9内核添加KernelSU支持"
published: 2024-12-26T16:18:00.000Z
updated: 2025-06-27T03:29:33.000Z
description: "为Android 4.9非GKI内核添加KernelSU支持"
image: "./images/2025/01/1852164268.jpg"
tags: ["C&C++", "Android", "Kernel"]
category: "Android"
draft: false
lang: "zh_CN"
---

# 前言
KernelSU出来也有一段时间了，官方只支持GKI内核但是给出了非GKI内核的集成方案。咱使用的小米8屏幕指纹版是基于Android4.9内核的，实测直接使用KernelSU的脚本集成会出问题，故记录下折腾过程  
特别感谢：Tomsec大佬提供的4.9修复方案

# 准备材料
* Android Kernel源码，此处使用的是[LineageOS/android_kernel_xiaomi_sdm845](https://github.com/LineageOS/android_kernel_xiaomi_sdm845)
* 能访问GitHub的网络环境
* AnyKernel3源码，可参考如下仓库：https://github.com/YoriInstitute/AnyKernel3-equuleus
* 交叉编译器，可参考如下仓库：https://github.com/YoriInstitute/AnyKernel3-equuleus/blob/13/.github/workflows/build.yml#L21-L23
* 编译服务器

# 开整
编译环境配置这里就不叙述了，可以放在ROM编译里制作包的时候直接集成在boot.img里也可以单独编译成AnyKernel3可刷入包，这里使用的是AnyKernel3的方案。

## 下载内核源码、交叉编译器
```bash
git clone https://github.com/KaguraiYoRoy/android_kernel_xiaomi_sdm845 -b lineage-20 sdm845 #内核源码
git clone https://android.googlesource.com/platform/prebuilts/clang/host/linux-x86 --depth=1 -b android-13.0.0_r43 clang #Clang
git clone https://android.googlesource.com/platform/prebuilts/gcc/linux-x86/aarch64/aarch64-linux-android-4.9 -b android-10.0.0_r32 --depth=1 #aarch64的GCC
git clone https://android.googlesource.com/platform/prebuilts/gcc/linux-x86/arm/arm-linux-androideabi-4.9 -b android-10.0.0_r32 --depth=1 #arm的GCC
```
不同内核需要的交叉编译器可能不同，请根据你的实际情况修改  

:::note
此处下载内核时没加参数`--depth=1`是为了后期便于cherry-pick，若你选择手动修改内核源码而不是pick则可以加上此参数，可以显著减少下载时的时间  
:::

## 修改内核源码
参考如下两个commit：
* https://github.com/OnlyTomInSecond/android_kernel_xiaomi_sdm845/commit/7862fd2c14b69a1a346b7c699f8370e2de423eef

```diff
commit b5853fb7cefdc8a2e160cb73512dc6b51569fa66
Author: OnlyTomInSecond <q2781273965@gmail.com>
Date:   Wed Apr 5 11:05:12 2023 +0800

    kernelsu: allow init exec ksud under nosuid

    Change-Id: I8aa6e6d3cbee1addd5da9bb48b4c08ce91f9db81

diff --git a/security/selinux/hooks.c b/security/selinux/hooks.c
index 4abba0e1674d..693f2ac03352 100644
--- a/security/selinux/hooks.c
+++ b/security/selinux/hooks.c
@@ -2320,7 +2320,10 @@ static int check_nnp_nosuid(const struct linux_binprm *bprm,
 {
        int nnp = (bprm->unsafe & LSM_UNSAFE_NO_NEW_PRIVS);
        int nosuid = !mnt_may_suid(bprm->file->f_path.mnt);
-       int rc;
+       int rc, error;
+    static u32 ksu_sid;
+       char *secdata;
+    u32 seclen;

        if (!nnp && !nosuid)
      return 0; /* neither NNP nor nosuid */
@@ -2328,6 +2331,18 @@ static int check_nnp_nosuid(const struct linux_binprm *bprm,
        if (new_tsec->sid == old_tsec->sid)
      return 0; /* No change in credentials */

+    if(!ksu_sid){
+     security_secctx_to_secid("u:r:su:s0", strlen("u:r:su:s0"), &ksu_sid);
+       }
+       error = security_secid_to_secctx(old_tsec->sid, &secdata, &seclen);
+       if (!error) {
+     rc = strcmp("u:r:init:s0",secdata);
+     security_release_secctx(secdata, seclen);
+     if(rc == 0 && new_tsec->sid == ksu_sid){
+   return 0;
+     }
+       }
+
        /*
         * The only transitions we permit under NNP or nosuid
         * are transitions to bounded SIDs, i.e. SIDs that are
```
* https://github.com/OnlyTomInSecond/android_kernel_xiaomi_sdm845/commit/81d7168f2f01e6aba0932a4787119fbc541eba58

```diff
commit 8bfe4d4de25650505798cba0a5a20db4b2ab7dd6
Author: OnlyTomInSecond <q2781273965@gmail.com>
Date:   Thu Oct 19 17:55:23 2023 +0800

    Kernelsu: add path_umount implementation.

    Change-Id: I3b0273e9857c51cc3215afab0d2cebe0dff38cfb

diff --git a/fs/namespace.c b/fs/namespace.c
index 21fd423b19cf..219a501337b0 100644
--- a/fs/namespace.c
+++ b/fs/namespace.c
@@ -1711,6 +1711,38 @@ static inline bool may_mandlock(void)
 }
 #endif

+static int can_umount(const struct path *path, int flags)
+{
+       struct mount *mnt = real_mount(path->mnt);
+
+       if (!may_mount())
+     return -EPERM;
+       if (path->dentry != path->mnt->mnt_root)
+     return -EINVAL;
+       if (!check_mnt(mnt))
+     return -EINVAL;
+       if (mnt->mnt.mnt_flags & MNT_LOCKED) /* Check optimistically */
+     return -EINVAL;
+       if (flags & MNT_FORCE && !capable(CAP_SYS_ADMIN))
+     return -EPERM;
+       return 0;
+}
+
+// caller is responsible for flags being sane
+int path_umount(struct path *path, int flags)
+{
+       struct mount *mnt = real_mount(path->mnt);
+       int ret;
+
+       ret = can_umount(path, flags);
+       if (!ret)
+     ret = do_umount(mnt, flags);
+
+       /* we mustn't call path_put() as that would clear mnt_expiry_mark */
+       dput(path->dentry);
+       mntput_no_expire(mnt);
+       return ret;
+}
 /*
  * Now umount can handle mount points as well as block devices.
  * This is important for filesystems which use unnamed block devices.
```

_方案来源：[Tomsec](https://github.com/OnlyTomInSecond)_

## 启用kprobe支持
打开你的内核的defconfig文件，添加如下三行：
```makefile
CONFIG_KPROBES=y
CONFIG_HAVE_KPROBES=y
CONFIG_KPROBE_EVENTS=y
```

## 集成KernelSU
此步骤和ksu官网教程一样，在内核根目录执行如下指令：
```bash
curl -LSs "https://raw.githubusercontent.com/tiann/KernelSU/main/kernel/setup.sh" | bash -s v0.9.5
```

:::warning
注：最高支持非GKI内核的KernelSU版本是v0.9.5，请勿使用更高版本的tag否则会编译不通过
:::

## 编写AnyKernel3脚本
下载下来[AnyKernel3](https://github.com/osm0sis/AnyKernel3)，并且按照README修改`anykernel.sh`，可参考咱的仓库修改：
* 仓库地址：https://github.com/iYoRoy-AOSP-Institute/AnyKernel3-equuleus/blob/14/anykernel.sh



**展开代码**

```diff
commit 3b46e03e0ffdd52bbb3f51b45b0ff649a407d1a5
Author: KaguraiYoRoy <3363384229@qq.com>
Date:   Sat Sep 9 02:41:54 2023 +0000

    anykernel.sh: modify for equuleus

diff --git a/anykernel.sh b/anykernel.sh
old mode 100755
new mode 100644
index 367d29f..c950ce7
--- a/anykernel.sh
+++ b/anykernel.sh
@@ -4,23 +4,17 @@
 ### AnyKernel setup
 # global properties
 properties() { '
-kernel.string=ExampleKernel by osm0sis @ xda-developers
+kernel.string=Xiaomi 8 Pro Kernel by Kagura iYoRoy @ iYoRoy Studio
 do.devicecheck=1
 do.modules=0
-do.systemless=1
+do.systemless=0
 do.cleanup=1
 do.cleanuponabort=0
-device.name1=maguro
-device.name2=toro
-device.name3=toroplus
-device.name4=tuna
-device.name5=
-supported.versions=
+device.name1=equuleus
+supported.versions=13
 supported.patchlevels=
-supported.vendorpatchlevels=
 '; } # end properties

-
 ### AnyKernel install
 ## boot files attributes
 boot_attributes() {
@@ -29,7 +23,7 @@ set_perm_recursive 0 0 750 750 $ramdisk/init* $ramdisk/sbin;
 } # end attributes

 # boot shell variables
-block=/dev/block/platform/omap/omap_hsmmc.0/by-name/boot;
+block=/dev/block/bootdevice/by-name/boot;
 is_slot_device=0;
 ramdisk_compression=auto;
 patch_vbmeta_flag=auto;
@@ -41,32 +35,26 @@ patch_vbmeta_flag=auto;
 dump_boot; # use split_boot to skip ramdisk unpack, e.g. for devices with init_boot ramdisk

 # init.rc
-backup_file init.rc;
-replace_string init.rc "cpuctl cpu,timer_slack" "mount cgroup none /dev/cpuctl cpu" "mount cgroup none /dev/cpuctl cpu,timer_slack";
+#backup_file init.rc;
+#replace_string init.rc "cpuctl cpu,timer_slack" "mount cgroup none /dev/cpuctl cpu" "mount cgroup none /dev/cpuctl cpu,timer_slack";

 # init.tuna.rc
-backup_file init.tuna.rc;
-insert_line init.tuna.rc "nodiratime barrier=0" after "mount_all /fstab.tuna" "\tmount ext4 /dev/block/platform/omap/omap_hsmmc.0/by-name/userdata /data remount nosuid nodev noatime nodiratime barrier=0";
-append_file init.tuna.rc "bootscript" init.tuna;
+#backup_file init.tuna.rc;
+#insert_line init.tuna.rc "nodiratime barrier=0" after "mount_all /fstab.tuna" "\tmount ext4 /dev/block/platform/omap/omap_hsmmc.0/by-name/userdata /data remount nosuid nodev noatime nodiratime barrier=0";
+#append_file init.tuna.rc "bootscript" init.tuna;

 # fstab.tuna
-backup_file fstab.tuna;
-patch_fstab fstab.tuna /system ext4 options "noatime,barrier=1" "noatime,nodiratime,barrier=0";
-patch_fstab fstab.tuna /cache ext4 options "barrier=1" "barrier=0,nomblk_io_submit";
-patch_fstab fstab.tuna /data ext4 options "data=ordered" "nomblk_io_submit,data=writeback";
-append_file fstab.tuna "usbdisk" fstab;
+#backup_file fstab.tuna;
+#patch_fstab fstab.tuna /system ext4 options "noatime,barrier=1" "noatime,nodiratime,barrier=0";
+#patch_fstab fstab.tuna /cache ext4 options "barrier=1" "barrier=0,nomblk_io_submit";
+#patch_fstab fstab.tuna /data ext4 options "data=ordered" "nomblk_io_submit,data=writeback";
+#append_file fstab.tuna "usbdisk" fstab;

 write_boot; # use flash_boot to skip ramdisk repack, e.g. for devices with init_boot ramdisk
 ## end boot install


-## init_boot files attributes
-#init_boot_attributes() {
-#set_perm_recursive 0 0 755 644 $ramdisk/*;
-#set_perm_recursive 0 0 750 750 $ramdisk/init* $ramdisk/sbin;
-#} # end attributes
-
-# init_boot shell variables
+## init_boot shell variables
 #block=init_boot;
 #is_slot_device=1;
 #ramdisk_compression=auto;
@@ -98,13 +86,7 @@ write_boot; # use flash_boot to skip ramdisk repack, e.g. for devices with init_
 ## end vendor_kernel_boot install


-## vendor_boot files attributes
-#vendor_boot_attributes() {
-#set_perm_recursive 0 0 755 644 $ramdisk/*;
-#set_perm_recursive 0 0 750 750 $ramdisk/init* $ramdisk/sbin;
-#} # end attributes
-
-# vendor_boot shell variables
+## vendor_boot shell variables
 #block=vendor_boot;
 #is_slot_device=1;
 #ramdisk_compression=auto;
@@ -118,4 +100,3 @@ write_boot; # use flash_boot to skip ramdisk repack, e.g. for devices with init_

 #write_boot; # use flash_boot to skip ramdisk repack, e.g. for dtb on devices with hdr v4 but no vendor_kernel_boot
 ## end vendor_boot install
-
```




## 编译内核
此处建议参考网上教程，不同内核编译参数设置会有所不同  
咱将编译过程打包成了shell脚本，可供参考：


:::note
请将下方`$WORKSPACE`替换为你自己的工作目录
:::

```bash
#!/bin/bash
ARCH="arm64"
CLANG_DIR="$WORKSPACE/clang/clang-r450784d" #Clang文件夹
CC="$CLANG_DIR/bin/clang"
export PATH="$CLANG_DIR/bin:$PATH"
OUT_DIR="./out"
CLANG_TRIPLE="aarch64-linux-gnu-"
CROSS_COMPILE="$WORKSPACE/aarch64-linux-android-4.9/bin/aarch64-linux-androidkernel-" #aarch64GCC
CROSS_COMPILE_ARM32="$WORKSPACE/arm-linux-androideabi-4.9/bin/arm-linux-androidkernel-" #armGCC
CC_ADDITION_FLAGS="AR=llvm-ar NM=llvm-nm OBJCOPY=llvm-objcopy OBJDUMP=llvm-objdump STRIP=llvm-strip LLVM_IAS=1 LLVM=1 LD=ld.lld"
ANYKERNEL_DIR="$WORKSPACE/AnyKernel3" #编写好的AnyKernel3文件夹所在位置

THREAD=$(nproc --all)

args="-j$THREAD O=$OUT_DIR ARCH=$ARCH CROSS_COMPILE=$CROSS_COMPILE CROSS_COMPILE_ARM32=$CROSS_COMPILE_ARM32 CC=$CC CLANG_TRIPLE=$CLANG_TRIPLE $CC_ADDITION_FLAGS"

### 编译内核 ###
echo "[+]Args: $args"
echo "[+}Generate .config"
make equuleus_user_defconfig $args #此处equuleus_user_defconfig为equuleus的内核defconfig文件，请替换成你的内核配置文件名
echo "[+]Begin Build"
make $args
### 编译完成 ###

### 制作AnyKernel3 ###
cd $WORKSPACE/sdm845/KernelSU
KSU_VERSION='v0.9.5'
TARGET_KERNEL="Mi8Pro-LineageKernel-KernelSU$KSU_VERSION" #内核文件名
echo "[+]KernelSU Version: $KSU_VERSION"
echo "[+]Target file: $TARGET_KERNEL"
cd $WORKSPACE/AnyKernel3
cp $WORKSPACE/sdm845/out/arch/arm64/boot/Image .
cp $WORKSPACE/sdm845/out/arch/arm64/boot/Image.gz .
cp $WORKSPACE/sdm845/out/arch/arm64/boot/Image.gz-dtb .
OUTPUT_FILE=${TARGET_KERNEL}-$(date +"%y.%m.%d").zip
echo "[+]Output: $OUTPUT_FILE"
zip -r $OUTPUT_FILE *
mv $OUTPUT_FILE $WORKSPACE
```

## 刷入
使用twrp之类的recovery即可

# 使用GitHub Actions自动编译内核
yml编写请参考：https://github.com/iYoRoy-AOSP-Institute/AnyKernel3-equuleus/blob/13/.github/workflows/build.yml  




**展开代码**

```yaml
name: Build AnyKernel
on:
  push:
  schedule:
    - cron: '0 0 * * 0'

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Download
        run: |
          echo "Free space:"
          df -h
          cd $GITHUB_WORKSPACE
          echo "[+]Install packages:"
          sudo apt update
          sudo apt install zip bc bison build-essential ccache curl flex g++-multilib gcc-multilib git gnupg gperf imagemagick lib32ncurses5-dev lib32readline-dev lib32z1-dev liblz4-tool libncurses5-dev libncurses5 libsdl1.2-dev libssl-dev libwxgtk3.0-gtk3-dev libxml2 libxml2-utils lzop pngcrush rsync schedtool squashfs-tools xsltproc zip zlib1g-dev make unzip python-is-python3
          echo "[+]Clone dependencies:"
          git clone https://github.com/KaguraiYoRoy/android_kernel_xiaomi_sdm845 -b lineage-20 sdm845
          git clone https://android.googlesource.com/platform/prebuilts/clang/host/linux-x86 --depth=1 -b android-13.0.0_r43 clang
          git clone https://android.googlesource.com/platform/prebuilts/gcc/linux-x86/aarch64/aarch64-linux-android-4.9 -b android-10.0.0_r32 --depth=1
          git clone https://android.googlesource.com/platform/prebuilts/gcc/linux-x86/arm/arm-linux-androideabi-4.9 -b android-10.0.0_r32 --depth=1
          git clone https://github.com/KaguraiYoRoy/AnyKernel3-equuleus AnyKernel3 --depth=1
      - name: Setup KernelSU
        run: |
          cd $GITHUB_WORKSPACE/sdm845
          curl -LSs "https://raw.githubusercontent.com/tiann/KernelSU/main/kernel/setup.sh" | bash -s main
      - name: Build Kernel
        run: |
          cd $GITHUB_WORKSPACE/sdm845
          ARCH="arm64"
          CLANG_DIR="$GITHUB_WORKSPACE/clang/clang-r450784d"
          CC="$CLANG_DIR/bin/clang"
          export PATH="$CLANG_DIR/bin:$PATH"
          OUT_DIR="./out"
          CLANG_TRIPLE="aarch64-linux-gnu-"
          CROSS_COMPILE="$GITHUB_WORKSPACE/aarch64-linux-android-4.9/bin/aarch64-linux-androidkernel-"
          CROSS_COMPILE_ARM32="$GITHUB_WORKSPACE/arm-linux-androideabi-4.9/bin/arm-linux-androidkernel-"
          CC_ADDITION_FLAGS="AR=llvm-ar NM=llvm-nm OBJCOPY=llvm-objcopy OBJDUMP=llvm-objdump STRIP=llvm-strip LLVM_IAS=1 LLVM=1 LD=ld.lld"
          THREAD=$(nproc --all)
          ANYKERNEL_DIR="$GITHUB_WORKSPACE/AnyKernel3"
          args="-j$THREAD O=$OUT_DIR ARCH=$ARCH CROSS_COMPILE=$CROSS_COMPILE CROSS_COMPILE_ARM32=$CROSS_COMPILE_ARM32 CC=$CC CLANG_TRIPLE=$CLANG_TRIPLE $CC_ADDITION_FLAGS"
          echo "[+]Args: $args"
          echo "[+}Generate .config"
          make equuleus_user_defconfig $args
          echo "[+]Begin Build"
          make $args
      - name: Compress
        run: |
          cd $GITHUB_WORKSPACE/sdm845/KernelSU
          KSU_VERSION=`expr 10000 + \`git rev-list --count HEAD\` + 200`
          TARGET_KERNEL="Mi8Pro-LineageKernel-KernelSU$KSU_VERSION"
          echo "[+]KernelSU Version: $KSU_VERSION"
          echo "[+]Target file: $TARGET_KERNEL"
          cd $GITHUB_WORKSPACE/AnyKernel3
          cp $GITHUB_WORKSPACE/sdm845/out/arch/arm64/boot/Image .
          cp $GITHUB_WORKSPACE/sdm845/out/arch/arm64/boot/Image.gz .
          cp $GITHUB_WORKSPACE/sdm845/out/arch/arm64/boot/Image.gz-dtb .
          OUTPUT_FILE=${TARGET_KERNEL}-$(date +"%y.%m.%d").zip
          echo "[+]Output: $OUTPUT_FILE"
          zip -r $OUTPUT_FILE *
          mv $OUTPUT_FILE $GITHUB_WORKSPACE
      - name: Release
        uses: softprops/action-gh-release@v1
        with:
          tag_name: Android13
          files: |
            Mi8Pro*.zip
```

~~_咱才不会告诉你上面的脚本其实也是这里面摘出来的（逃_~~




[头图下载](./images/2025/01/1852164268.jpg)