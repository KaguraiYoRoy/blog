---
title: "简述对AOSP设备树中的一些文件和概念的理解"
published: 2025-02-03T03:58:00.000Z
updated: 2025-06-27T03:29:21.000Z
description: "简述对AOSP设备树中的一些文件和概念的理解"
image: "./images/2025/02/2527021884.jpg"
tags: ["Android", "AOSP", "caf/clo"]
category: "Android"
categories: ["Android"]
draft: false
lang: "zh_CN"
---

:::warning
以下内容很大一部分是我个人对设备树中一些概念的理解，并非官方定义的概念，如有错误欢迎指正
:::

设备树所共有的内容大致分为以下几类：
* Android.bp
* 各种Makefile，后缀.mk
* prop文件，后缀.prop
* overlay，放在overlay文件夹中
* sepolicy，即SELinux规则，放在sepolicy文件夹中
* manifest.xml和FCM（framework_compatibility_manifest.xml）
* extract-files.py、setup-makefiles.py和proprietary-files.txt
* .dependencies结尾的依赖文件
* 其他各种配置

# Android.bp
这是AOSP构建系统Ninja的配置文件，设备树对它的依赖不大（主要内容都放在Android.mk和其他Makefile里了），一般用于引入其他的**soong_namespace**，以引用其他文件夹下的Modules。此处以LineageOS的socrates设备树为例：
```makefile
//
// Copyright (C) 2024 The LineageOS Project
//
// SPDX-License-Identifier: Apache-2.0
//

soong_namespace {
    imports: [
        "hardware/xiaomi",
    ],
}
```
此处声明导入了**hardware/xiaomi**下的namespace，这样使得`PRODUCT_PACKAGES`可以引用到hardware/xiaomi中的项目

# Makefile
## Android.mk
这个文件定义了整个设备树的入口（应该是），还是以socrates为例：
```makefile
#
# Copyright (C) 2024 The LineageOS Project
#
# SPDX-License-Identifier: Apache-2.0
#

LOCAL_PATH := $(call my-dir)

ifeq ($(TARGET_DEVICE),socrates)
include $(LOCAL_PATH)/vendor-symlinks.mk
include $(call all-subdir-makefiles,$(LOCAL_PATH))

include $(CLEAR_VARS)
# A/B builds require us to create the mount points at compile time.
# Just creating it for all cases since it does not hurt.
FIRMWARE_MOUNT_POINT := $(TARGET_OUT_VENDOR)/firmware_mnt
$(FIRMWARE_MOUNT_POINT): $(LOCAL_INSTALLED_MODULE)
	@echo "Creating $(FIRMWARE_MOUNT_POINT)"
	@mkdir -p $(TARGET_OUT_VENDOR)/firmware_mnt

BT_FIRMWARE_MOUNT_POINT := $(TARGET_OUT_VENDOR)/bt_firmware
$(BT_FIRMWARE_MOUNT_POINT): $(LOCAL_INSTALLED_MODULE)
	@echo "Creating $(BT_FIRMWARE_MOUNT_POINT)"
	@mkdir -p $(TARGET_OUT_VENDOR)/bt_firmware

DSP_MOUNT_POINT := $(TARGET_OUT_VENDOR)/dsp
$(DSP_MOUNT_POINT): $(LOCAL_INSTALLED_MODULE)
	@echo "Creating $(DSP_MOUNT_POINT)"
	@mkdir -p $(TARGET_OUT_VENDOR)/dsp

ALL_DEFAULT_INSTALLED_MODULES += $(FIRMWARE_MOUNT_POINT) $(BT_FIRMWARE_MOUNT_POINT) $(DSP_MOUNT_POINT)
endif
```

可以看出，如果`TARGET_DEVICE`等于**socrates**，编译系统才会继续引用这个文件夹下的所有Makefile，并会在此定义一些挂载点。

## AndroidProduct.mk
这个文件一般用于引入下面的**os_codename.mk**，并定义`COMMON_LUNCH_CHOICES`，它定义了lunch时该设备支持的类型（一般在此区分user、userdebug和eng类型的构建）  
注：`COMMON_LUNCH_CHOICES`貌似在Android14及以上的构建中取消了

## BoardConfig.mk
:::note
一般在common tree中（如果有）会被命名成**BoardConfigCommon.mk**
:::

顾名思义，这是手机的板级配置文件，一般定义了像CPU的架构、分区大小、内核参数等，一般会在此处引入SEPolicy文件夹、各个prop文件、manifest.xml、FCM和其他一些硬件上的参数等  

此处的配置大部分可以在各个rom之间通用

## device.mk
:::note
一般在common tree中（如果有）会被命名成**soc.mk**或者**common.mk**，比如在小米的sdm845-common中被命名为**sdm845.mk**，在小米的sm7250-common中被命名为**lito.mk**
:::

这个文件一般定义的是Android操作系统中的一些服务、引入各种库、复制权限文件（如：[LineageOS/android_device_xiaomi_sdm845-common/blob/lineage-22.1/sdm845.mk#L26-L62](https://github.com/LineageOS/android_device_xiaomi_sdm845-common/blob/lineage-22.1/sdm845.mk#L26-L62)）

此处的内容有一部分是各个rom间通用的，具体请视情况而定

## os_codename.mk
此处定义的一般是和当前ROM高度相关的内容，比如以socrates为例：
```makefile
#
# Copyright (C) 2024 The LineageOS Project
#
# SPDX-License-Identifier: Apache-2.0
#

# Inherit common AOSP configurations
$(call inherit-product, build/make/target/product/full_base_telephony.mk)
$(call inherit-product, build/make/target/product/core_64_bit_only.mk)

# Inherit device-specific configurations
$(call inherit-product, device/xiaomi/socrates/device.mk)

# Inherit LineageOS configurations
$(call inherit-product, vendor/lineage/config/common_full_phone.mk)

PRODUCT_NAME := lineage_socrates
PRODUCT_DEVICE := socrates
PRODUCT_MODEL := Redmi K60 Pro
PRODUCT_BRAND := Redmi
PRODUCT_MANUFACTURER := Xiaomi

BUILD_FINGERPRINT := Redmi/socrates/socrates:14/UKQ1.230804.001/V816.0.11.0.UMKCNXM:user/release-keys
```

引入了构建时必要的配置和lineage的配置，在此处引用不同的配置文件可设置操作系统位数和区分平板还是手机  

如此处引入了build/make/target/product/core_64_bit_only.mk这个文件，代表当前设备树编译出来的ROM只支持64位应用，如果此处引入core_64_bit.mk则会一并支持32位应用  
此处引入了vendor/lineage/config/common_full_phone.mk代表是为手机类型的设备适配的，若为平板类型的设备则需要引入common_full_tablet.mk或者common_full_tablet_wifionly.mk之类的

下面则定义了设备相关的信息，如制造厂、厂商、设备codename和model

# Prop文件
此处定义的是系统内的**Property属性**，和系统内的prop文件功能相同，定义了某些依赖prop作为设置项的软件需要的条目。建议参考网上的介绍，此处不多介绍

# Overlay
官方介绍：
Android Overlay是一种资源替换机制，它能在不重新打包apk的情况下，实现资源文件的替换（res目录非assert目录）

个人理解：用于替换和覆写系统内指定软件的res的xml的特定内容，可以此修改系统设置、开关等。  

举个例子：[https://github.com/LineageOS/android_device_xiaomi_socrates/blob/lineage-22.1/overlay/SystemUIOverlaySocrates/res/values/config.xml#L24](https://github.com/LineageOS/android_device_xiaomi_socrates/blob/lineage-22.1/overlay/SystemUIOverlaySocrates/res/values/config.xml#L24)  



**展开代码**

```xml
<?xml version="1.0" encoding="utf-8"?>
<!--
/*
** Copyright 2009, The Android Open Source Project
**
** Licensed under the Apache License, Version 2.0 (the "License");
** you may not use this file except in compliance with the License.
** You may obtain a copy of the License at
**
**     http://www.apache.org/licenses/LICENSE-2.0
**
** Unless required by applicable law or agreed to in writing, software
** distributed under the License is distributed on an "AS IS" BASIS,
** WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
** See the License for the specific language governing permissions and
** limitations under the License.
*/
-->

<!-- These resources are around just to allow their values to be customized
     for different hardware and product builds. -->
<resources>
    <!-- Doze: does this device support STATE_DOZE?  -->
    <bool name="doze_display_state_supported">true</bool><!--这一行-->

    <!-- Color of the UDFPS pressed view -->
    <color name="config_udfpsColor">#00FFFFFF</color>

    <!-- paddings for container with status icons and battery -->
    <dimen name="status_bar_icons_padding_start">0dp</dimen>
    <dimen name="status_bar_icons_padding_end">0dp</dimen>

    <!-- the padding on the start of the statusbar -->
    <dimen name="status_bar_padding_start">10dp</dimen>

    <!-- the padding on the end of the statusbar -->
    <dimen name="status_bar_padding_end">4dp</dimen>
</resources>
```




此处修改的就是[https://github.com/LineageOS/android_frameworks_base/blob/lineage-22.1/packages/SystemUI/res/values/config.xml#L175](https://github.com/LineageOS/android_frameworks_base/blob/lineage-22.1/packages/SystemUI/res/values/config.xml#L175)
这里的同名变量，并以此标识设备是否支持Doze display：[https://github.com/LineageOS/android_frameworks_base/blob/472a48741ac22537b3a0d1c0b87dbff2c1c2af8f/packages/SystemUI/src/com/android/systemui/statusbar/phone/DozeParameters.java#L185-L187](https://github.com/LineageOS/android_frameworks_base/blob/472a48741ac22537b3a0d1c0b87dbff2c1c2af8f/packages/SystemUI/src/com/android/systemui/statusbar/phone/DozeParameters.java#L185-L187)

在编写overlay时一般需要参考系统内对res中的项的定义，并根据需要替换其中的值

# .dependencies文件
顾名思义，依赖，此处定义了使用这个设备树还需要哪些依赖的仓库，使用json编码。基本格式如下：
```json
[
   {
      "repository": "",
      "target_path": "",
      "branch": "",
      "remote": ""
   },
   {
      "repository": "",
      "target_path": "",
      "branch": "",
      "remote": ""
   }
]
```

参数详解：
* `remote`: 远程地址，对应的主代码树manifest中的远程地址。该参数非必须，若不指定则默认按照主代码树manifest中的默认远程地址克隆
* `repository`: 仓库地址，即远程地址下的这个仓库，必须
* `branch`: 分支，对应从指定repository下载时的分支。非必须，若不指定则默认和主代码树分支相同
* `target_path`: 克隆目标地址，必须
* `clone-path`: 克隆深度，同git指令clone时的`--depth`参数。非必须，若不指定则默认是全部下载（和git指令一个逻辑）
* `revision`: 可以理解为branch，非必须

因此不带那些可选参数时一个最简单的dependences可以是这样的：
* https://github.com/LineageOS/android_device_xiaomi_equuleus/blob/lineage-22.1/lineage.dependencies

```json
[
  {
    "repository": "android_device_xiaomi_sdm845-common",
    "target_path": "device/xiaomi/sdm845-common"
  }
]
```

在使用类似breakfast这样的自动下载支持的设备树的指令的时候会根据这个文件将需要的仓库整合进主代码树的manifest并一并下载下来

# extract-files.py、setup-makefiles.py和proprietary-files.txt
这些文件是生成Vendor tree的时候用的，一般在proprietary-files.txt里写好需要的blobs，然后运行extract-files.py从系统或者dump中提取blobs并制成vendor tree

先写这么多，后面有待补充（
