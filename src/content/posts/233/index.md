---
title: "记一次手动安装Proxmox VE, 配置多路iSCSI与NAT转发的经历"
published: 2025-11-29T09:39:00.000Z
updated: 2025-11-29T15:33:42.000Z
description: "将一台没有预装 PVE 镜像的物理机重装为 Debian 13，再手动安装 Proxmox VE，恢复多路 iSCSI 数据盘，并配置虚拟机的 NAT 和端口转发。"
image: ""
tags: ["网络技术", "PVE", "iSCSI"]
category: "运维"
categories: ["运维", "网络技术"]
draft: false
lang: "zh_CN"
---

起因是租了一台物理机, 然后IDC那边没有提供PVE和Debian系统镜像, 只有Ubuntu、CentOS、Windows系列. 同时数据盘是通过多路iSCSI提供的. 我希望使用PVE来对不同使用场景进行隔离, 因此尝试重装并迁移上述配置.

# 备份配置
首先对系统做个大致的检查, 可发现: 
1. 系统存在两张网卡, 一张`enp24s0f0`接入了公网地址, 用于外部访问; 一张`enp24s0f1`接入了`192.168.128.153`的私网地址
2. 数据盘被映射为了`/dev/mapper/mpatha`
3. `/etc/iscsi`下存在两个iSCSI Node的配置, 分别为`192.168.128.250:3260`、`192.168.128.252:3260`, 但是二者都对应`iqn.2024-12.com.ceph:iscsi`.
不难推断出, 数据盘挂载是通过同时配置两个iSCSI Node, 再使用多路的方式合并成一个设备.

查看一下系统的网络配置: 
```yaml
network:
  version: 2
  renderer: networkd
  ethernets:
    enp24s0f0:
      addresses: [211.154.[数据删除]/24]
      routes:
        - to: default
          via: [数据删除]
      match:
          macaddress: ac:1f:6b:0b:e2:d4
      set-name: enp24s0f0
      nameservers:
        addresses:
          - 114.114.114.114
          - 8.8.8.8
    enp24s0f1:
      addresses:
        - 192.168.128.153/17
      match:
        macaddress: ac:1f:6b:0b:e2:d5
      set-name: enp24s0f1
```

发现就是非常简单的静态路由, 内网网卡甚至没有默认路由, 直接绑定IP即可.  

然后将`/etc/iscsi`下iSCSI的配置文件保存一下, 其中包含了账户密码等信息

# 重装Debian
此次使用的是[bin456789/reinstall](https://github.com/bin456789/reinstall)重装脚本.  
下载脚本:   
```shell
curl -O https://cnb.cool/bin456789/reinstall/-/git/raw/main/reinstall.sh || wget -O ${_##*/} $_
```

重装成Debian 13:  
```shell
bash reinstall.sh debian 13
```
然后根据提示输入你想要设置的密码即可

如果不出意外的话, 等待10分钟左右, 会自动完成并重装成一个纯净的Debian 13. 中途可以通过ssh配合设置的密码连接, 查看安装进度.  

重装完成后按照惯例进行一个换源和`apt upgrade`, 即可得到一个纯净的Debian 13啦  
换源直接参考[USTC镜像站的教程](https://mirrors.ustc.edu.cn/help/debian.html)即可

# 安装Proxmox VE
这一步主要参考Proxmox官方的[教程](https://pve.proxmox.com/wiki/Install_Proxmox_VE_on_Debian_12_Bookworm)即可  

需要注意，上述脚本安装的Debian会将主机名设置为`localhost`，你如果想要修改的话请在**配置Hostname**前修改并将hosts中的主机名改成你修改的主机名而非`localhost`

## 配置Hostname
Proxmox VE要求为当前的主机名配置一个指向非回环地址的Hosts:

> The hostname of your machine must be resolvable to an IP address. This IP address must not be a loopback one like `127.0.0.1` but one that you and other hosts can connect to.

比如此处我的服务器IP为`211.154.[数据删除]`, 我需要在`/etc/hosts`中添加如下的一条记录:
```diff
127.0.0.1       localhost
+211.154.[数据删除] localhost
::1             localhost ip6-localhost ip6-loopback
ff02::1         ip6-allnodes
ff02::2         ip6-allrouters
```

保存后, 使用`hostname --ip-address`检查是否会输出设置的非回环地址: `::1 127.0.0.1 211.154.[数据删除]`

## 添加Proxmox VE软件源
Debian 13使用了Deb822格式~~当然你想用sources.list也可以~~, 因此直接参考[USTC的Proxmox镜像站](https://mirrors.ustc.edu.cn/help/proxmox.html)即可: 
```shell
cat > /etc/apt/sources.list.d/pve-no-subscription.sources <<EOF
Types: deb
URIs: https://mirrors.ustc.edu.cn/proxmox/debian/pve
Suites: trixie
Components: pve-no-subscription
Signed-By: /usr/share/keyrings/proxmox-archive-keyring.gpg
EOF
```

此处需要同步迁移一个keyring过来~~但是我上网找了一圈没找到~~, 因此我选择从我现有的一个Proxmox VE服务器上拉过来一份. 放在这里了: [proxmox-keyrings.zip](/downloads/2025/11/4102711242.zip)  
将公钥文件解压放在`/usr/share/keyrings/`中, 然后运行
```shell
apt update
apt upgrade -y
```
即可同步Proxmox VE软件源

## 安装Proxmox VE内核
使用如下命令安装PVE内核并重启以应用新内核: 
```shell
apt install proxmox-default-kernel
reboot
```
之后通过`uname -r`应该能看到当前使用的是类似于`6.17.2-2-pve`这样以pve结尾的内核版本, 代表新内核应用成功.

## 安装Proxmox VE相关软件包
使用apt安装对应软件包: 
```shell
apt install proxmox-ve postfix open-iscsi chrony
```
配置过程中会需要设置`postfix`邮件服务器, 官方解释: 
> 如果您的网络中有邮件服务器, 则应将postfix配置为`Satellite system`. 然后, 您现有的邮件服务器将成为中继主机, 将Proxmox VE发送的电子邮件路由到其最终收件人.
如果您不知道在此处输入什么, 请仅选择`Local only`, 并保持系统hostname不变.

之后应该能访问`https://<你的服务器地址>:8006`来打开Web控制台了, 账户为root, 密码为你的root密码, 即重装Debian时配置的密码.

## 删除旧的Debian内核和`os-prober`
使用以下命令:
```shell
apt remove linux-image-amd64 'linux-image-6.1*'
update-grub
apt remove os-prober
```
来移除旧的Debian内核, 更新grub并移除`os-prober`. 移除`os-prober`不是必须的, 但是官方建议这么做, 因为它可能会误将虚拟机的引导文件认成多系统的引导文件, 导致将不该加的一些东西加到引导列表中.

至此, Proxmox VE的安装就完成了, 已经可以正常使用啦！

# 配置内网网卡
因为IDC那边iSCSI网卡和公网走的不是同一张, 而重装的时候丢失了这部分的配置, 因此需要手动配置一下内网的网卡.  
打开Proxmox VE的Web后台, 找到**Datacenter**-**localhost**（主机名）-**Network**, 编辑内网网卡, 如我这里的是`ens6f1`, 填入上面备份的IPv4的CIDR格式: `192.168.128.153/17`并勾选**Autostart**, 接着保存即可.  
接着使用命令来设置网卡状态为UP: 
```shell
ip link set ens6f1 up
```
现在能Ping通内网iSCSI服务器的IP了.

# 配置数据盘
## iSCSI
在上一步中, 我们应该已经安装了`iscsiadm`所需的软件包`open-iscsi`, 我们只需要按照之前备份的配置重新设置node即可.  

首先发现一下iSCSI存储:   
```shell
iscsiadm -m discovery -t st -p 192.168.128.250:3260
```
可以得到原先存在的两个LUN Target:   
```txt
192.168.128.250:3260,1 iqn.2024-12.com.ceph:iscsi
192.168.128.252:3260,2 iqn.2024-12.com.ceph:iscsi
```

将备份的配置文件传到服务器上, 覆盖掉原先的`/etc/iscsi`中的配置, 同时, 在我备份的配置中可以找到验证方面的配置: 
```ini
# /etc/iscsi/nodes/iqn.2024-12.com.ceph:iscsi/192.168.128.250,3260,1/default
# BEGIN RECORD 2.1.5
node.name = iqn.2024-12.com.ceph:iscsi
... # 略去一些不重要的配置
node.session.auth.authmethod = CHAP
node.session.auth.username = [数据删除]
node.session.auth.password = [数据删除]
node.session.auth.chap_algs = MD5
... # 略去一些不重要的配置
```
```ini
# /etc/iscsi/nodes/iqn.2024-12.com.ceph:iscsi/192.168.128.252,3260,2/default
# BEGIN RECORD 2.1.5
node.name = iqn.2024-12.com.ceph:iscsi
... # 略去一些不重要的配置
node.session.auth.authmethod = CHAP
node.session.auth.username = [数据删除]
node.session.auth.password = [数据删除]
node.session.auth.chap_algs = MD5
... # 略去一些不重要的配置
```
按照这些配置文件写入新的系统: 
```shell
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.authmethod -v CHAP
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.username -v [数据删除]
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.password -v [数据删除]
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.chap_algs -v MD5

iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 -o update -n node.session.auth.authmethod -v CHAP
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 -o update -n node.session.auth.username -v [数据删除]
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 -o update -n node.session.auth.password -v [数据删除]
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.session.auth.chap_algs -v MD5
```
（我不知道为什么验证信息需要单独写入一次, 但是实测下来不重写它无法登录）  

接着, 使用:
```shell
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 --login
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 --login
```
登录Target, 接着使用: 
```shell
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.250:3260 -o update -n node.startup -v automatic
iscsiadm -m node -T iqn.2024-12.com.ceph:iscsi -p 192.168.128.252:3260 -o update -n node.startup -v automatic
```
开启开机自动挂载.  

这个时候通过`lsblk`之类的工具查看磁盘应该就能发现多了两块硬盘, 我这里多出来了`sdb`和`sdc`.

## 配置multipath多路径
关于如何识别出是多路径设备, 我尝试通过:
```shell
/usr/lib/udev/scsi_id --whitelisted --device=/dev/sdb
/usr/lib/udev/scsi_id --whitelisted --device=/dev/sdc
```
查看两个磁盘设备的`scsi_id`, 发现二者是相同的, 因此可推断二者是同一块盘, 使用了多路来实现类似负载均衡和故障转移的效果

使用apt安装`multipath`:
```shell
apt install multipath-tools
```
接着, 创建`/etc/multipath.conf`并填入: 
```nginx
defaults {
    user_friendly_names yes
    find_multipaths yes
}
```

配置`multipathd`开机自启: 
```shell
systemctl start multipathd
systemctl enable multipathd
```

接着, 使用如下指令扫描并自动配置多路设备:
```shell
multipath -ll
```
会输出: 
```txt
mpatha(360014056229953ef442476e85501bfd7)dm-0LIO-ORG,TCMU device
size=500G features='1 queue_if_no_path' hwhandler='1 alua'wp=rw
|-+- policy='service-time 0' prio=50 status=active
| `- 14:0:0:152 sdb 8:16 active ready running
`-+- policy='service-time 0' prio=50 status=active
  `- 14:0:0:152 sdc 8:16 active ready running
```
可看到已经将两块盘识别成同一个多路设备了. 此时, 可以在`/dev/mapper/`下找到多路设备的磁盘: 
```shell
root@localhost:/dev/mapper# ls
control  mpatha
```
`mpatha`即为多路聚合的磁盘. 

如果没扫描到，可尝试使用:
```shell
rescan-scsi-bus.sh
```
重新扫描SCSI总线后再次尝试，若提示找不到这个指令可以用`apt install sg3-utils`安装. 
~~实在不行咱重启一下~~

## 配置Proxmox VE使用数据盘
因为我们使用了多路, 因此不能直接选择添加iSCSI类型的存储.  
使用如下指令创建PV和VG:
```shell
pvcreate /dev/mapper/mpatha
vgcreate <vg名称> /dev/mapper/mpatha
```
此处我将整块盘都配置成了PV, 你也可以单独划分出来一个分区来做这件事  

完成后, 打开Proxmox VE的后台管理, 找到**Datacenter**-**Storage**, 点击**Add**-**LVM**, **Volume group**选择刚刚创建的VG的名称, **ID**自己给他命个名, 然后点击**Add**即可.

自此, 所有原系统的配置应该已经都迁移过来了

# 配置NAT
## NAT地址转换
因为只买了一个IPv4地址, 所以需要配置一下NAT来让所有虚拟机都能正常上网.  
打开`/etc/network/interfaces`, 添加如下内容: 
```txt
auto vmbr0
iface vmbr0 inet static
    address   192.168.100.1
    netmask   255.255.255.0
    bridge_ports none
    bridge_stp off
    bridge_fd 0

    post-up   echo 1 > /proc/sys/net/ipv4/ip_forward
    post-up   iptables -t nat -A POSTROUTING -s 192.168.100.0/24 -o ens6f0 -j MASQUERADE
    post-up   iptables -t raw -I PREROUTING -i fwbr+ -j CT --zone 1
    post-up   iptables -A FORWARD -i vmbr0 -j ACCEPT
    post-down iptables -t nat -D POSTROUTING -s 192.168.100.0/24 -o ens6f0 -j MASQUERADE
    post-down iptables -t raw -D PREROUTING -i fwbr+ -j CT --zone 1
    post-down iptables -D FORWARD -i vmbr0 -j ACCEPT
```
其中, `vmbr0`为NAT网桥, 网桥IP段为`192.168.100.0/24` , 该网段流量会被转换为`ens6f0`外网网卡的IP发出, 并在收到回复时转换为原始IP, 实现共享外部IP.   

接着, 使用: 
```shell
ifreload -a
```
重载配置. 

到此, 虚拟机就已经能实现上网了, 只需要安装的时候配置静态地址为`192.168.100.0/24`内的地址, 默认网关设置为`192.168.100.1`, 并配置DNS地址即可. 

## 端口转发
~~懒了, 直接拷打AI~~  

让AI写了个配置脚本`/usr/local/bin/natmgr`: 
```shell
#!/bin/bash

# =================配置区域=================
# 公网网卡名称 (请根据实际情况修改)
PUB_IF="ens6f0"
# =========================================

ACTION=$1
ARG1=$2
ARG2=$3
ARG3=$4
ARG4=$5

# 检查是否为 root 用户
if [ "$EUID" -ne 0 ]; then
  echo "请使用 root 权限运行此脚本"
  exit 1
fi

# 生成随机 ID (6位字符)
generate_id() {
    # 引入纳秒和随机盐以确保即使脚本执行速度很快，ID也不会重复
    echo "$RANDOM $(date +%s%N)" | md5sum | head -c 6
}

# 显示帮助信息
usage() {
    echo "用法: $0 {add|del|list|save} [参数]"
    echo ""
    echo "命令:"
    echo "  add <公网端口> <内网IP> <内网端口> [协议]   添加转发规则"
    echo "      [协议] 可选: tcp, udp, both (默认: both)"
    echo "  del <ID>                                   通过 ID 删除转发规则"
    echo "  list                                       查看当前所有转发规则"
    echo "  save                                       保存当前规则，使其在重启后仍然存在 (必须运行!)"
    echo ""
    echo "示例:"
    echo "  $0 add 8080 192.168.100.101 80 both"
    echo "  $0 save"
    echo ""
}

# 内部函数：添加单条协议规则
_add_single_rule() {
    local PROTO=$1
    local L_PORT=$2
    local T_IP=$3
    local T_PORT=$4

    local RULE_ID=$(generate_id)
    local COMMENT="NAT_ID:${RULE_ID}"

    # 1. 添加 DNAT 规则 (PREROUTING 链)
    iptables -t nat -A PREROUTING -i $PUB_IF -p $PROTO --dport $L_PORT -j DNAT --to-destination $T_IP:$T_PORT -m comment --comment "$COMMENT"

    # 2. 添加 FORWARD 规则 (允许数据包通过)
    iptables -A FORWARD -p $PROTO -d $T_IP --dport $T_PORT -m comment --comment "$COMMENT" -j ACCEPT

    # 输出结果
    printf "%-10s %-10s %-10s %-20s %-10s\n" "$RULE_ID" "$PROTO" "$L_PORT" "$T_IP:$T_PORT" "成功"
    
    # 提醒用户保存
    echo "请运行 '$0 save' 命令以确保规则在重启后仍然存在。"
}

# 主添加函数
add_rule() {
    local L_PORT=$1
    local T_IP=$2
    local T_PORT=$3
    local PROTO_REQ=${4:-both} # 默认为 both

    if [[ -z "$L_PORT" || -z "$T_IP" || -z "$T_PORT" ]]; then
        echo "错误: 参数缺失"
        usage
        exit 1
    fi

    # 转换为小写
    PROTO_REQ=$(echo "$PROTO_REQ" | tr '[:upper:]' '[:lower:]')

    echo "正在添加规则..."
    printf "%-10s %-10s %-10s %-20s %-10s\n" "ID" "协议" "公网端口" "目标地址" "状态"
    echo "------------------------------------------------------------------"

    if [[ "$PROTO_REQ" == "tcp" ]]; then
        _add_single_rule "tcp" "$L_PORT" "$T_IP" "$T_PORT"
    elif [[ "$PROTO_REQ" == "udp" ]]; then
        _add_single_rule "udp" "$L_PORT" "$T_IP" "$T_PORT"
    elif [[ "$PROTO_REQ" == "both" ]]; then
        _add_single_rule "tcp" "$L_PORT" "$T_IP" "$T_PORT"
        _add_single_rule "udp" "$L_PORT" "$T_IP" "$T_PORT"
    else
        echo "错误: 不支持的协议 '$PROTO_REQ'。请使用 tcp, udp 或 both。"
        exit 1
    fi
    echo "------------------------------------------------------------------"
}

# 删除规则 (基于行号倒序删除)
del_rule() {
    local RULE_ID=$1

    if [[ -z "$RULE_ID" ]]; then
        echo "错误: 请提供规则 ID"
        usage
        exit 1
    fi

    echo "正在搜索 ID 为 [${RULE_ID}] 的规则..."
    
    local FOUND=0

    # --- 清理 NAT 表 (PREROUTING) ---
    LINES=$(iptables -t nat -nL PREROUTING --line-numbers | grep "NAT_ID:${RULE_ID}" | awk '{print $1}' | sort -rn)
    if [[ ! -z "$LINES" ]]; then
        for line in $LINES; do
            iptables -t nat -D PREROUTING $line
            echo "已删除 NAT 表 PREROUTING 链第 $line 行"
            FOUND=1
        done
    fi

    # --- 清理 Filter 表 (FORWARD) ---
    LINES=$(iptables -t filter -nL FORWARD --line-numbers | grep "NAT_ID:${RULE_ID}" | awk '{print $1}' | sort -rn)
    if [[ ! -z "$LINES" ]]; then
        for line in $LINES; do
            iptables -t filter -D FORWARD $line
            echo "已删除 Filter 表 FORWARD 链第 $line 行"
            FOUND=1
        done
    fi

    if [[ $FOUND -eq 0 ]]; then
        echo "未找到 ID 为 $RULE_ID 的规则。"
    else
        echo "删除操作完成。"
        echo "请运行 '$0 save' 命令以更新持久化配置文件。"
    fi
}

# 保存规则到磁盘 (新增功能)
save_rules() {
    echo "正在保存当前的 iptables 规则..."
    # netfilter-persistent 是 Debian/Proxmox 中管理 iptables-persistent 的服务
    if command -v netfilter-persistent &> /dev/null; then
        netfilter-persistent save
        if [ $? -eq 0 ]; then
            echo "✅ 规则已成功保存到 /etc/iptables/rules.v4，将在系统重启后自动恢复。"
        else
            echo "❌ 规则保存失败。请检查 'netfilter-persistent' 服务状态。"
        fi
    else
        echo "警告: 未找到 'netfilter-persistent' 命令。"
        echo "请确保已安装 'iptables-persistent' 软件包。"
        echo "安装命令: apt update && apt install iptables-persistent"
    fi
}

# 列出规则
list_rules() {
    echo "当前端口转发规则列表:"
    printf "%-10s %-10s %-10s %-20s %-10s\n" "ID" "协议" "公网端口" "目标地址" "目标端口"
    echo "------------------------------------------------------------------"

    # 解析 iptables 输出
    iptables -t nat -nL PREROUTING -v | grep "NAT_ID:" | while read line; do
        id=$(echo "$line" | grep -oP '(?<=NAT_ID:)[^ ]*')
        
        # 提取协议
        if echo "$line" | grep -q "tcp"; then proto="tcp"; else proto="udp"; fi
        
        # 提取 dpt: 之后的端口
        l_port=$(echo "$line" | grep -oP '(?<=dpt:)[0-9]+')
        
        # 提取 to: 之后的 IP:Port
        target=$(echo "$line" | grep -oP '(?<=to:).*')
        t_ip=${target%:*}
        t_port=${target#*:}

        printf "%-10s %-10s %-10s %-20s %-10s\n" "$id" "$proto" "$l_port" "$t_ip" "$t_port"
    done
}

# 主逻辑
case "$ACTION" in
    add)
        add_rule "$ARG1" "$ARG2" "$ARG3" "$ARG4"
        ;;
    del)
        del_rule "$ARG1"
        ;;
    list)
        list_rules
        exit 0
        ;;
    save)
        save_rules
        ;;
    *)
        usage
        exit 1
        ;;
esac
save_rules
```
让其自动添加/删除iptables规则实现端口转发. 记得`chmod +x`  

通过`iptables-persistent`实现保存配置开机自动加载:
```shell
apt install iptables-persistent
```
配置过程中会询问是否需要保存当前规则，Yes或者No都可以。

添加转发规则时使用`natmgr add <主机监听地址> <虚拟机内网IP> <虚拟机端口> [tcp/udp/both]`即可, 脚本会自动分配一个唯一ID, 删除时使用`natmgr del <ID>`即可. 也可使用`natmgr list`查看已有转发列表. 

-----
参考文章: 
1. [bin456789/reinstall: 一键DD/重装脚本 (One-click reinstall OS on VPS) - GitHub](https://github.com/bin456789/reinstall)
2. [Install Proxmox VE on Debian 12 Bookworm - Proxmox VE](https://pve.proxmox.com/wiki/Install_Proxmox_VE_on_Debian_12_Bookworm)
3. [PVE连接 TrueNAS iSCSI存储实现本地无盘化_pve iscsi-CSDN博客](https://blog.csdn.net/qq_26129413/article/details/121790221)
4. [ProxmoxVE (PVE) NAT 网络配置方法 - Oskyla 烹茶室](https://frytea.com/archives/1445/)