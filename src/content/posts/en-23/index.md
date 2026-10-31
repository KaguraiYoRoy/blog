---
title: "Brief Understanding of Some Files and Concepts in AOSP Device Trees"
published: 2025-02-03T03:58:00.000Z
updated: 2025-11-20T06:11:06.000Z
description: "A comprehensive guide explaining key files and concepts in AOSP device trees, including Android.bp, various Makefiles (Android.mk, BoardConfig.mk, device.mk), prop files, overlays, sepolicy, dependencies, and vendor blob extraction scripts."
image: "./images/2025/02/2527021884.jpg"
tags: ["Android", "AOSP", "caf/clo"]
category: "Android"
draft: false
lang: "en_US"
---

:::warning
The following content largely represents my personal understanding of some concepts within device trees and is not official definitions. Corrections are welcome if any errors are found.
:::

The common contents of a device tree can be broadly categorized as follows:
* Android.bp
* Various Makefiles, with the suffix `.mk`
* prop files, with the suffix `.prop`
* overlay, placed in the overlay folder
* sepolicy, i.e., SELinux rules, placed in the sepolicy folder
* manifest.xml and FCM (framework_compatibility_matrix.xml)
* extract-files.py, setup-makefiles.py, and proprietary-files.txt
* Dependency files ending with `.dependencies`
* Various other configurations

# Android.bp
This is the configuration file for the AOSP build system, Ninja. The device tree doesn't rely heavily on it (main content is usually in Android.mk and other Makefiles). It's generally used to introduce other **soong_namespaces**, allowing references to Modules from other directories. Let's take the LineageOS socrates device tree as an example:
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
Here, it declares the import of the namespace from **hardware/xiaomi**, enabling PRODUCT_PACKAGES to reference items from hardware/xiaomi.

# Makefile
## Android.mk
This file defines the entry point for the entire device tree (it should be). Again, using socrates as an example:
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

It shows that if `TARGET_DEVICE` equals **socrates**, the build system will proceed to include all Makefiles in this directory and define some mount points here.

## AndroidProduct.mk
This file is typically used to include the `os_codename.mk` file below and define `COMMON_LUNCH_CHOICES`. It defines the types supported by the device during lunch (generally distinguishing between user, userdebug, and eng builds).
Note: `COMMON_LUNCH_CHOICES` seems to have been removed in Android 14 and above builds.

## BoardConfig.mk
:::note
In common trees (if they exist), this is often named **BoardConfigCommon.mk**
:::

As the name suggests, this is the board configuration file for the phone. It generally defines things like CPU architecture, partition sizes, kernel parameters, etc. It usually includes the SEPolicy folder, various prop files, manifest.xml, FCM, and other hardware-related parameters.  

Most configurations here are generally reusable across different ROMs.  

## device.mk
:::note
In common trees (if they exist), this is often named `soc.mk` or `common.mk`. For example, it's named `sdm845.mk` in Xiaomi's sdm845-common and `lito.mk` in Xiaomi's sm7250-common.
:::

This file generally defines services within the Android operating system, includes various libraries, copies permission files (e.g., [LineageOS/android_device_xiaomi_sdm845-common/blob/lineage-22.1/sdm845.mk#L26-L62](https://github.com/LineageOS/android_device_xiaomi_sdm845-common/blob/lineage-22.1/sdm845.mk#L26-L62)).

Some of the content here is reusable across different ROMs; please decide based on the specific situation.

## os_codename.mk
This file typically defines content highly specific to the current ROM. For example, using socrates:  
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

It includes necessary configurations for the build and LineageOS configurations. Referencing different configuration files here can set the operating system bitness and distinguish between tablet and phone.  

For instance, including `build/make/target/product/core_64_bit_only.mk` means the ROM built from this device tree only supports 64-bit apps. If `core_64_bit.mk` were included instead, it would also support 32-bit apps.
Including `vendor/lineage/config/common_full_phone.mk` indicates adaptation for a phone-type device. For a tablet-type device, `common_full_tablet.mk` or `common_full_tablet_wifionly.mk` would be included.  

The section below defines device-related information like manufacturer, brand, device codename, and model.  

# Prop Files
These define **Property attributes** within the system, functioning similarly to prop files inside the system. They define entries required by software that relies on props for settings. It's recommended to refer to online introductions for details, as we won't elaborate much here.

# Overlay
Official introduction:
Android Overlay is a resource replacement mechanism that allows replacing resource files without repackaging the APK (res directory, not assets directory).  

Personal understanding: Used to replace and override specific content in the res XML of specified software within the system, allowing modifications to system settings, toggles, etc.  

For example: [https://github.com/LineageOS/android_device_xiaomi_socrates/blob/lineage-22.1/overlay/SystemUIOverlaySocrates/res/values/config.xml#L24](https://github.com/LineageOS/android_device_xiaomi_socrates/blob/lineage-22.1/overlay/SystemUIOverlaySocrates/res/values/config.xml#L24)



**Expand Code**

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




This modifies the variable of the same name here: [https://github.com/LineageOS/android_frameworks_base/blob/lineage-22.1/packages/SystemUI/res/values/config.xml#L175](https://github.com/LineageOS/android_frameworks_base/blob/lineage-22.1/packages/SystemUI/res/values/config.xml#L175)
and thereby indicates whether the device supports Doze display:[https://github.com/LineageOS/android_frameworks_base/blob/472a48741ac22537b3a0d1c0b87dbff2c1c2af8f/packages/SystemUI/src/com/android/systemui/statusbar/phone/DozeParameters.java#L185-L187](https://github.com/LineageOS/android_frameworks_base/blob/472a48741ac22537b3a0d1c0b87dbff2c1c2af8f/packages/SystemUI/src/com/android/systemui/statusbar/phone/DozeParameters.java#L185-L187)

When writing overlays, one generally needs to reference the definitions of items in the res within the system and replace their values as needed.  

# .dependencies Files
As the name implies, dependencies. This file defines which dependent repositories are needed to use this device tree, encoded in JSON. The basic format is as follows:  
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

Parameter details:
* `remote`: The remote address, corresponding to the remote address in the main source tree's manifest. This parameter is optional. If not specified, it defaults to cloning from the default remote address in the main source tree's manifest.
* `repository`: The repository address, i.e., this repository under the remote address. Required.
* `branch`: The branch corresponding to the branch used when downloading from the specified repository. Optional. If not specified, it defaults to the same branch as the main source tree.
* `target_path`: The clone target path. Required.
* `clone-path`: The clone depth, similar to the `--depth` parameter in the git clone command. Optional. If not specified, it defaults to a full download (same logic as the git command).
* `revision`: Can be understood as the branch. Optional.

Therefore, a simplest dependencies file without the optional parameters can look like this:
* https://github.com/LineageOS/android_device_xiaomi_equuleus/blob/lineage-22.1/lineage.dependencies

```json
[
  {
    "repository": "android_device_xiaomi_sdm845-common",
    "target_path": "device/xiaomi/sdm845-common"
  }
]
```

When using commands like `breakfast` that automatically download supported device trees, this file is used to integrate the required repositories into the main source tree's manifest and download them together.

# extract-files.py, setup-makefiles.py, and proprietary-files.txt
These files are used when generating the Vendor tree. Generally, the required blobs are listed in proprietary-files.txt, then extract-files.py is run to extract blobs from the system or a dump and create the vendor tree.  

That's all for now, more may be added later.  
