---
title: "Migrating RR Loader for Synology DSM"
published: 2025-01-29T16:36:00.000Z
updated: 2025-11-06T01:06:02.000Z
description: "Moving an RR boot drive from USB to a slightly smaller Optane disk by copying the first two partitions, recreating the third, and transferring its files, UUID, and label."
image: ""
tags: ["Linux", "Synology"]
category: "NAS"
categories: ["NAS"]
draft: false
lang: "en_US"
---

I wrote this article because the original disk was a 16GB USB drive, and the target disk is a 16GB Optane. Although both are 16GB, the original one is slightly larger (I don't know why either orz).  
Directly using dd won't work since the source disk is larger than the target, so I'm documenting the process here.

:::warning
Data is priceless, tinkering requires caution.
:::

# Analysis
The RR boot disk has three partitions:  
1. FAT32,50.00MB  
2. Ext2,50.00MB  
3. Ext4,occupying the remaining space  

The first partition is the boot partition and is bootable (marked with an asterisk under "Boot" in `fdisk -l`). The second partition's purpose is unclear, but it's likely for GRUB. The third partition holds Synology's kernel and RR Loader configuration files.

# Approach
Since the first two partitions are small, we can use `dd` to copy them entirely to the target disk. For the third partition, we'll manually create and format it, then synchronize the UUID and Label.

:::info
This process uses Linux operations.
:::

# Let's Start
Connect both disks to the system: source disk as `/dev/sda`, target disk as `/dev/sdb`.   
Check the source disk information:
```bash
sudo fdisk -l /dev/sda
```

Output:  
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

## Copy the First Two Partitions and Disk Partition Table to the Target Disk
```bash
sudo dd if=/dev/sda of=/dev/sdb bs=512 count=206848 # This example uses 512-byte sectors; count is the third partition's starting sector. Adjust for your disk.
```

Output:  
```text
206848+0 records in
206848+0 records out
105906176 bytes (106 MB, 101 MiB) copied, 11.3812 s, 9.3 MB/s
```

## Create the Third Partition
Open the disk with fdisk:  
```bash
sudo fdisk /dev/sdb
```
First, wipe the existing third partition data: Type `d`, and when prompted with `Partition number (1-3, default 3):`, enter `3` or just press Enter.
After seeing `Partition 3 has been deleted.`, type `n` to create a new partition. Select `primary partition` by typing `p`, and accept the default options for the rest by pressing Enter. Once done, type `w` to save and exit.  
If you're unfamiliar with fdisk, search for tutorials online.  

# Format the Newly Created Partition and Write UUID and Label
```bash
sudo mkfs.ext4 /dev/sdb3
```

Check the details of the source disk's third partition using the file command:  
```bash
sudo file -s /dev/sda3
```

Output:  
```text
/dev/sda3: Linux rev 1.0 ext4 filesystem data, UUID=617a3aca-4b56-42d7-8558-54411b344a7d, volume name "RR3" (extents) (64bit) (large files) (huge files)
```

Note down the `UUID` and `volume name` (i.e., "RR3"), and use the following commands to write them to the new disk:
```bash
sudo tune2fs /dev/sdb3 -U 617a3aca-4b56-42d7-8558-54411b344a7d # Use the UUID recorded from your source partition.
sudo tune2fs /dev/sdb3 -L RR3 # Write volume name
```

# Copy data
Mount the third partitions of both disks. Assume the source is mounted at `~/a` and the target at `~/b`. Then, copy all data from a to b (this step is straightforward with `cp`, so no detailed explanation needed).

Finally, unmount all mount points, disconnect the disks, and connect them to your NAS. The migration should be successful.
