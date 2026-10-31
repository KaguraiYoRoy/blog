---
title: "Adding KernelSU Support to Android 4.9 Kernel"
published: 2024-12-26T16:18:00.000Z
updated: 2025-11-05T14:47:04.000Z
description: "A comprehensive guide on adding KernelSU support to a non-GKI Android 4.9 kernel for the Xiaomi Mi 8, including source modification, compilation steps, and automated GitHub Actions workflow."
image: "./images/2025/01/1852164268.jpg"
tags: ["C&C++", "Android", "Kernel"]
category: "Android"
categories: ["Android", "Develop"]
draft: false
lang: "en_US"
---

# Introduction
KernelSU has been available for a while. Officially, it only supports GKI kernels, but the project provides integration guidelines for non-GKI kernels. The Xiaomi Mi 8 Pro, which I use, is based on the Android 4.9 kernel. Testing showed that directly using KernelSU's integration script caused issues, so I'm documenting the process here.  
Special thanks to: Developer Tomsec for providing the 4.9 kernel fix.

# Prerequisites
* Android Kernel source code. Here, we use [LineageOS/android_kernel_xiaomi_sdm845](https://github.com/LineageOS/android_kernel_xiaomi_sdm845)
* Network access to GitHub
* AnyKernel3 source code. You can refer to this repository: [YoriInstitute/AnyKernel3-equuleus](https://github.com/YoriInstitute/AnyKernel3-equuleus)
* Cross-compiler. You can refer to this repository: [https://github.com/YoriInstitute/AnyKernel3-equuleus/blob/13/.github/workflows/build.yml#L21-L23](https://github.com/YoriInstitute/AnyKernel3-equuleus/blob/13/.github/workflows/build.yml#L21-L23)
* A build server

# Let's Start
Configuring the build environment won't be detailed here. You can integrate it directly into the `boot.img` when building the ROM, or compile it separately as an AnyKernel3 flashable zip. This guide uses the AnyKernel3 approach.

## Download Kernel Source Code and Cross-Compiler
```bash
git clone https://github.com/KaguraiYoRoy/android_kernel_xiaomi_sdm845 -b lineage-20 sdm845 #Kernel source
git clone https://android.googlesource.com/platform/prebuilts/clang/host/linux-x86 --depth=1 -b android-13.0.0_r43 clang #Clang
git clone https://android.googlesource.com/platform/prebuilts/gcc/linux-x86/aarch64/aarch64-linux-android-4.9 -b android-10.0.0_r32 --depth=1 #aarch64 GCC
git clone https://android.googlesource.com/platform/prebuilts/gcc/linux-x86/arm/arm-linux-androideabi-4.9 -b android-10.0.0_r32 --depth=1 #arm GCC
```
Different kernels might require different cross-compilers. Please adjust according to your specific case.

:::note
When cloning the kernel source, `--depth=1` wasn't used initially to facilitate easier cherry-picking later. If you plan to manually modify the kernel source instead of using cherry-pick, you can add this parameter to significantly reduce download time. 
:::

## Modify Kernel Source
Refer to the following two commits:  
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

_Solution Source: [Tomsec](https://github.com/OnlyTomInSecond)_

## Enable KPROBE Support
Open your kernel's defconfig file and add the following three lines:  
```makefile
CONFIG_KPROBES=y
CONFIG_HAVE_KPROBES=y
CONFIG_KPROBE_EVENTS=y
```

## Integrate KernelSU
This step is the same as the official ksu guide. Execute the following command in the kernel root directory:  
```bash
curl -LSs "https://raw.githubusercontent.com/tiann/KernelSU/main/kernel/setup.sh" | bash -s v0.9.5
```

:::warning
Note: The highest version of KernelSU supporting non-GKI kernels is v0.9.5. Do not use a higher version tag, or the build will fail.
:::

## Write the AnyKernel3 Script
Download [AnyKernel3](https://github.com/osm0sis/AnyKernel3) and modify anykernel.sh according to the README. You can refer to my repository for modifications:  
* Repository: https://github.com/iYoRoy-AOSP-Institute/AnyKernel3-equuleus/blob/14/anykernel.sh



**Expand Code**

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




## Compile the Kernel
It's recommended to refer to online tutorials for this step, as compilation parameter settings can vary for different kernels.  
I've packaged the compilation process into a shell script for reference:

:::note
Please replace `$WORKSPACE` below with your own working directory.
:::

```bash
#!/bin/bash
ARCH="arm64"
CLANG_DIR="$WORKSPACE/clang/clang-r450784d" #Clang directory
CC="$CLANG_DIR/bin/clang"
export PATH="$CLANG_DIR/bin:$PATH"
OUT_DIR="./out"
CLANG_TRIPLE="aarch64-linux-gnu-"
CROSS_COMPILE="$WORKSPACE/aarch64-linux-android-4.9/bin/aarch64-linux-androidkernel-" #aarch64 GCC
CROSS_COMPILE_ARM32="$WORKSPACE/arm-linux-androideabi-4.9/bin/arm-linux-androidkernel-" #arm GCC
CC_ADDITION_FLAGS="AR=llvm-ar NM=llvm-nm OBJCOPY=llvm-objcopy OBJDUMP=llvm-objdump STRIP=llvm-strip LLVM_IAS=1 LLVM=1 LD=ld.lld"
ANYKERNEL_DIR="$WORKSPACE/AnyKernel3" #Location of your prepared AnyKernel3 directory

THREAD=$(nproc --all)

args="-j$THREAD O=$OUT_DIR ARCH=$ARCH CROSS_COMPILE=$CROSS_COMPILE CROSS_COMPILE_ARM32=$CROSS_COMPILE_ARM32 CC=$CC CLANG_TRIPLE=$CLANG_TRIPLE $CC_ADDITION_FLAGS"

### Compile Kernel ###
echo "[+]Args: $args"
echo "[+}Generate .config"
make equuleus_user_defconfig $args #Here 'equuleus_user_defconfig' is the defconfig file for the equuleus kernel. Replace it with your kernel's config file name.
echo "[+]Begin Build"
make $args
### Compilation Complete ###

### Create AnyKernel3 Zip ###
cd $WORKSPACE/sdm845/KernelSU
KSU_VERSION='v0.9.5'
TARGET_KERNEL="Mi8Pro-LineageKernel-KernelSU$KSU_VERSION" #Kernel filename
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

## Flashing
Use a recovery like TWRP to flash the zip.

# Automatically Compile the Kernel using GitHub Actions
Refer to this YAML file for workflow setup: https://github.com/iYoRoy-AOSP-Institute/AnyKernel3-equuleus/blob/13/.github/workflows/build.yml  




**Expand Code**

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

~~_I definitely won't tell you that the script above was also extracted from here x_~~


