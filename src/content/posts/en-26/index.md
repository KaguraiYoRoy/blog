---
title: "Using Infrared Camera for Face Recognition on Xiaomi 845 Series with Custom ROMs"
published: 2025-03-06T14:57:00.000Z
updated: 2025-11-09T05:47:17.000Z
description: "A technical guide explaining how to enable the infrared camera for face unlock on Xiaomi 845 series devices (Mi 8) under custom ROMs like LineageOS, by configuring the correct CameraID and modifying the vendor.camera.aux.packagelist system property."
image: ""
tags: ["Android", "AOSP", "caf/clo"]
category: "Android"
categories: ["Android", "Develop"]
draft: false
lang: "en_US"
---

# Background
The Xiaomi 845 series, specifically the Mi 8 and Mi 8 Pro (UDFPS), feature a dedicated front-facing infrared camera for facial recognition. This enables facial unlock functionality even in complete darkness. However, when using a custom ROM like LineageOS compiled from its standard device tree, the infrared camera remains inaccessible, forcing the system to rely on the standard front camera. Interestingly, PixelExperience ROMs successfully utilize this hardware. This article explores the reasons behind this discrepancy and outlines the solution.

# The Cause
## CameraID
The first step is directing the face recognition module to use the infrared camera. Examining the PixelExperience device tree source code reveals an overlay that configures the face unlock service to use the camera with ID `5`.

* https://github.com/PixelExperience-Devices/device_xiaomi_dipper/blob/fourteen/overlay/packages/apps/FaceUnlockService/app/src/main/res/values/config.xml

```xml
<?xml version="1.0" encoding="utf-8"?>
<resources>
    <integer name="override_front_cam_id">5</integer>
    <bool name="use_alternative_vendor_impl">true</bool>
</resources>
```

PixelExperience uses Motorola's face unlock solution. Many other custom ROMs, however, utilize AOSPA's ParanoidSense. Therefore, the PixelExperience overlay method isn't directly applicable.

Inspecting the ParanoidSense source code shows that it uses a system property, `ro.face.sense_service.camera_id`, to identify which camera to use.

* https://github.com/AOSPA/android_packages_apps_ParanoidSense/blob/uvite/src/co/aospa/sense/camera/CameraUtil.kt#L32

```java
    val cameraIdProp = SystemProperties.get("ro.face.sense_service.camera_id")
```

Thus, in theory, simply setting the `ro.face.sense_service.camera_id` property to 5 should direct it to the infrared camera.

## The `vendor.camera.aux.packagelist` Property
Merely setting the CameraID property is insufficient; the face unlock module would simply fail to access the camera. Delving into the Android framework code reveals that the system, by default, hides auxiliary cameras (AuxCameras) beyond the primary front and rear cameras. The infrared camera falls into this AuxCamera category.  

Using LineageOS framework code as an example:  
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

As shown, even if a device has more than two cameras, if the `shouldExposeAuxCamera()` function returns False, the system reports only two cameras, preventing access to any camera with an ID greater than `1`. Let's examine this function:

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

The logic is clear: if the current application's package name is listed in the `vendor.camera.aux.packagelist` system property and is not in the `vendor.camera.aux.packageexcludelist` property, the function returns `True`, allowing access to auxiliary cameras. 

The solution becomes evident: add the ParanoidSense package name (`co.aospa.sense`) to the `vendor.camera.aux.packagelist` property.

# The Solution
Add the ParanoidSense package name `co.aospa.sense` to the `vendor.camera.aux.packagelist` property:
* https://github.com/YoriInstitute/crDroidAndroid_device_xiaomi_sdm845-common/commit/28fe5bc41d49b31b4acb840bf167b70d70a40c61

Set the `ro.face.sense_service.camera_id` property to specify the correct camera ID:
* https://github.com/YoriInstitute/crDroidAndroid_device_xiaomi_equuleus/commit/67518f130650e4592b5f4c7210248072058d48cc
* https://github.com/YoriInstitute/AOSPA_device_xiaomi_equuleus/blob/topaz/device.mk#L397-L399

In the crDroid-modified version of ParanoidSense, which is placed in the `system_ext` partition (refer: [https://gitlab.com/crdroidandroid/android_packages_apps_FaceUnlock/-/commit/545688260eb32ba19f348e84e3cae89ba29f20d1](https://gitlab.com/crdroidandroid/android_packages_apps_FaceUnlock/-/commit/545688260eb32ba19f348e84e3cae89ba29f20d1)), this property should be added to the corresponding `system_ext` prop file.