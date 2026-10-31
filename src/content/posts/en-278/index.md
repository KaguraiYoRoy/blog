---
title: "Adapting NFC Functionality for QWRT on Xiaomi BE10000 Router"
published: 2026-05-25T15:18:00.000Z
updated: 2026-05-25T15:18:54.000Z
description: "This article details how to restore and adapt NFC tap-to-connect Wi-Fi functionality for the Xiaomi BE10000 router flashed with QWRT. It covers locating the NFC EEPROM chip via I2C bus scanning, constructing NDEF/WSC-compliant Wi-Fi configuration tokens, performing fragmented writes using i2ctransfer, and implementing a three-layer auto-trigger mechanism based on UCI, hotplug, and cron jobs, with MD5 hash verification to protect EEPROM lifespan. Full code repository link included."
image: ""
tags: ["OpenWRT", "Router", "NFC", "IoT", "Wi-Fi"]
category: "Develop"
draft: false
lang: "en_US"
---

## English Translation

**Title:** Adapting NFC Functionality for QWRT on Xiaomi BE10000 Router

# Analysis
After flashing the Xiaomi BE10000 with QWRT, the device's network potential is indeed greatly unleashed. Advanced features such as 2.5G optical modules and SFP+ interfaces work perfectly. The only drawback is that the factory NFC "tap to connect to Wi-Fi" feature no longer works. After researching, the NFC tag is essentially an EEPROM chip mounted on the motherboard. Using `i2cdetect` for scanning:

```bash
root@QWRT:~# i2cdetect -l
i2c-1   i2c             QUP I2C adapter                         I2C adapter
i2c-2   i2c             QUP I2C adapter                         I2C adapter
i2c-0   i2c             QUP I2C adapter                         I2C adapter
root@QWRT:~# i2cdetect -y -r 0
     0  1  2  3  4  5  6  7  8  9  a  b  c  d  e  f
00:          -- -- -- -- -- -- -- -- -- -- -- -- -- 
10: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
20: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
30: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
40: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
50: -- -- -- -- 54 -- -- -- -- -- -- -- -- -- -- -- 
60: -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- -- 
70: -- -- -- -- -- -- -- --  
```
The scan results quickly pinpoint the device attached to I2C bus `0` at physical address `0x54`.
NFC tap-to-connect-to-Wi-Fi uses standard NDEF format data (Ref: [Wi-Fi Simple Configuration — ndeflib 0.3.2 documentation](https://ndeflib.readthedocs.io/en/stable/records/wifi.html)). Therefore, simply writing the data into the EEPROM according to the standard can restore the NFC tap-to-connect functionality.

# Implementation
> This article discusses only low-level hardware driver adaptation and NDEF standard protocol encapsulation for the OpenWrt/QWRT system. The hardware parameters mentioned are derived from public specification documents and generic I2C debugging tools. This project is for personal research interest and does not include or distribute any vendor-proprietary binary code. It is intended for technical exchange and learning only. Do not use for commercial purposes. Any risk of device damage resulting from attempts described herein shall be borne solely by the reader.

## Extract Data and Construct NDEF Payload
To automatically update NFC data based on Wi-Fi credentials, we first need to obtain the current Wi-Fi SSID and password. On OpenWrt, these configurations are managed entirely by **UCI (Unified Configuration Interface)**. Therefore, we only need to read the `wireless` configuration file from UCI.  
To ensure compatibility with modern smartphones, early devices typically used a Device Password Token to trigger WPS negotiation, but modern Android/iOS systems have restricted this behavior. For broader compatibility, we must follow the Wi-Fi Simple Configuration (WSC) specification and package the configuration as a **WLAN Configuration Token** (credential configuration token). (Ref: [Wi-Fi Simple Configuration — ndeflib 0.3.2 documentation](https://ndeflib.readthedocs.io/en/stable/records/wifi.html#ndef-record-classes))  
Map OpenWrt's wireless encryption modes (e.g., WPA2, WPA3-SAE) precisely to the hex codes defined by the WSC specification:  
- `0x1003`: Authentication Type  
- `0x100F`: Encryption Type  
- `0x1045`: SSID  
- `0x1027`: Network Key (password)  
Through a script, we automatically traverse and select the primary AP bridged to `lan` (e.g., `wifi0`), convert its attributes to hex strings, and produce a standard NDEF payload.

## Write to NFC EEPROM
When the NFC EEPROM receives a long string of NDEF data, writing too quickly or in excessively large blocks per write can easily cause the chip's I2C state machine to lock up.  
After testing, we chose to use the `i2ctransfer` tool for atomic fragmented writes. Two critical timing details:  
1. Due to communication limitations, each loop slices only 4 bytes, with auto-incrementing register addresses.  
2. Between each 4-byte block write, a 10 ms delay is enforced to allow sufficient internal erase/write time for the chip. Finally, any remaining data less than 4 bytes is padded with `0x00`.

## Automatically Trigger Writes on Wi-Fi Configuration Changes
To closely follow OpenWrt's architecture, we initially tried using hooks but found they often failed. Eventually, three fallback layers were added:  
1. **LuCI frontend trigger**: Register a hook under `/etc/uci-defaults/` to bind the NFC sync script to the system's `ucitrack` mechanism. When a user modifies the Wi-Fi password in LuCI and clicks "Save & Apply", the system automatically updates the NFC data in the background.  
2. **Hotplug layer**: Add a hotplug event listener in `/etc/hotplug.d/iface/70-nfc`. When the router's `lan` or `wifi` interface changes to `ifup` state, the system automatically triggers the sync.  
3. **Cron job**: If none of the above triggers work, a cron job forces a check every 15 seconds to determine if an NFC update is needed.

Additionally, considering that the NFC EEPROM has limited write endurance, if the network interface restarts even once and triggers a full rewrite, the chip would soon wear out. Therefore, a simple hash check mechanism is introduced in the underlying `nfc-sync` script:  
1. When the script is awakened, it first extracts the current `wireless` configuration and calculates its MD5 hash.  
2. It compares this hash with the old hash cached in `/var/run/nfc-wireless.md5`.  
3. **Only when the MD5 value actually changes does it issue the I2C write command.** Otherwise, the process terminates immediately. Combined with a concurrent file lock (`/var/lock/nfc-sync.lock`), this logic ensures that the NFC hardware's lifespan is absolutely protected against any network flapping or multiple concurrent events.

---
After testing, automatic updating works as expected:

![[Pasted image 20260525230448.png]]

Code repository: [KaguraiYoRoy/be10000-qwrt-nfc: NFC Userland Implementation of QWRT for Xiaomi BE10000 (RC01) Router](https://github.com/KaguraiYoRoy/be10000-qwrt-nfc)

---
References:  
1. [Wi-Fi Simple Configuration — ndeflib 0.3.2 documentation](https://ndeflib.readthedocs.io/en/stable/records/wifi.html#ndef-record-classes)
