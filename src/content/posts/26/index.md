---
title: "小米845系列机器类原生调用红外摄像头进行人脸识别"
published: 2025-03-06T14:57:00.000Z
updated: 2025-06-27T03:29:14.000Z
description: "使小米845系列机器类原生能够调用红外摄像头以进行人脸识别"
image: ""
tags: ["Android", "AOSP", "caf/clo"]
category: "Android"
categories: ["Android", "开发"]
draft: false
lang: "zh_CN"
---

# 背景
小米845系列的小米8、小米8屏幕指纹版有一颗前置红外摄像头用于面部识别，这样即使在无光的环境下仍可以使用面部解锁。然而如果使用LineageOS的设备树不加修改编译出来的类原生无法使用红外摄像头，只能使用普通的摄像头，而PixelExperience的设备树是可以的，故探究其原因。  

# 原因
## CameraID
首先是需要指定人脸识别模块使用红外摄像头。翻阅PixelExperience的相关设备树源码可以发现：在overlay中设置了调用`CameraID`为**5**的摄像头用作人脸识别。
* https://github.com/PixelExperience-Devices/device_xiaomi_dipper/blob/fourteen/overlay/packages/apps/FaceUnlockService/app/src/main/res/values/config.xml

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <integer name="override_front_cam_id">5</integer>
    <bool name="use_alternative_vendor_impl">true</bool>
</resources>
```

PixelExperience使用的是motorola的人脸解锁方案，而现在很多类原生使用的是AOSPA的ParanoidSense，因此上述设置的overlay并不适用。  

查阅ParanoidSense源码可以看到：使用了**Properties属性**`ro.face.sense_service.camera_id`标识使用的摄像头。
* https://github.com/AOSPA/android_packages_apps_ParanoidSense/blob/uvite/src/co/aospa/sense/camera/CameraUtil.kt#L32

```java
    val cameraIdProp = SystemProperties.get("ro.face.sense_service.camera_id")
```

因此理论上只要设置`ro.face.sense_service.camera_id`属性为5即可使其调用红外人脸摄像头。  

## vendor.camera.aux.packagelist属性
如果仅仅设置上述CameraID相关属性，那么人脸模块调用时会直接报错。翻阅Frameworks部分的代码可以得知：系统默认隐藏了除主前摄和主后摄之外的其他辅助摄像头（即AUXCamera），而红外摄像头也属于AUXCamera之一。

取LineageOS的Framework代码作为例子：
* https://github.com/LineageOS/android_frameworks_base/blob/lineage-21.0/core/java/android/hardware/Camera.java#L295-L301

```java
    /**
     * Returns the number of physical cameras available on this device.
     * The return value of this method might change dynamically if the device
     * supports external cameras and an external camera is connected or
     * disconnected.
     *
     * If there is a
     * {@link android.hardware.camera2.CameraCharacteristics#REQUEST_AVAILABLE_CAPABILITIES_LOGICAL_MULTI_CAMERA
     * logical multi-camera} in the system, to maintain app backward compatibility, this method will
     * only expose one camera per facing for all logical camera and physical camera groups.
     * Use camera2 API to see all cameras.
     *
     * @return total number of accessible camera devices, or 0 if there are no
     *   cameras or an error was encountered enumerating them.
     */
    public static int getNumberOfCameras() {
        int numberOfCameras = _getNumberOfCameras();
        if (!shouldExposeAuxCamera() && numberOfCameras > 2) {
            numberOfCameras = 2;
        }
        return numberOfCameras;
    }
```

不难看出，即使设备有大于2颗摄像头，若函数`shouldExposeAuxCamera()`返回为False则会强制指定摄像头数量为2，阻止程序访问CameraID>2的摄像头；再来看看这个判断函数的定义：  

* https://github.com/LineageOS/android_frameworks_base/blob/lineage-21.0/core/java/android/hardware/Camera.java#L264-L278

```java
    /**
     * @hide
     */
    public static boolean shouldExposeAuxCamera() {
        /**
         * Force to expose only two cameras
         * if the package name does not falls in this bucket
         */
        String packageName = ActivityThread.currentOpPackageName();
        if (packageName == null)
            return true;
        List<String> packageList = Arrays.asList(
                SystemProperties.get("vendor.camera.aux.packagelist", packageName).split(","));
        List<String> packageExcludelist = Arrays.asList(
                SystemProperties.get("vendor.camera.aux.packageexcludelist", "").split(","));

        return packageList.contains(packageName) && !packageExcludelist.contains(packageName);
    }
```

可以看出，假如包名在属性`vendor.camera.aux.packagelist`中并且不在`vendor.camera.aux.packageexcludelist`中就会返回为True，否则False。  

那么解决方案就很明了了：将ParanoidSense的包名加到vendor.camera.aux.packagelist属性中即可让其能够调用到红外摄像头。

# 解决
将ParanoidSense的包名`co.aospa.sense`加到`vendor.camera.aux.packagelist`中：
* https://github.com/YoriInstitute/crDroidAndroid_device_xiaomi_sdm845-common/commit/28fe5bc41d49b31b4acb840bf167b70d70a40c61

设置`ro.face.sense_service.camera_id`属性以指定摄像头：
* https://github.com/YoriInstitute/crDroidAndroid_device_xiaomi_equuleus/commit/67518f130650e4592b5f4c7210248072058d48cc
* https://github.com/YoriInstitute/AOSPA_device_xiaomi_equuleus/blob/topaz/device.mk#L397-L399

在crDroid魔改的ParanoidSense中，因指定了其位于system_ext（https://gitlab.com/crdroidandroid/android_packages_apps_FaceUnlock/-/commit/545688260eb32ba19f348e84e3cae89ba29f20d1），故将这个属性加到system_ext的prop文件中。