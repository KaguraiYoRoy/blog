---
title: "充分利用systemd的特性构建多租户CodeServer"
published: 2026-06-06T07:34:00.000Z
updated: 2026-06-06T07:36:04.000Z
description: "本文详细介绍如何利用 systemd 的特性（资源限制、沙盒隔离、Path 单元）构建多租户 CodeServer 环境，实现用户独立运行、密码自助修改、Python 环境隔离，并意外防御 CopyFail/DirtyFrag 等内核漏洞。适合希望在 Linux 服务器上为多个用户安全提供浏览器 VSCode 的运维人员。"
image: ""
tags: ["systemd", "codeserver"]
category: "运维"
draft: false
lang: "zh_CN"
---

# 分析
起因是大学Python课，不想每次课都带笔记本过去太重了，尝试能不能一个平板就搞定。找来找去发现[coder/code-server: VS Code in the browser](https://github.com/coder/code-server)很符合要求，同时还能兼顾跨平台。当时自己部署了一个玩玩，后来朋友他们也想要，就在思考怎么弄能够兼顾多租户和安全性。最开始想到的是容器化，但是因为涉及到pip安装新的包，容器化不太好做，可能得把python的site-package什么的一堆都给持久化，而且性能也不好，所以还是打算使用二进制部署。  
需求很简单，大致概括如下：
1. 每个用户可以用自己的域名登录进入CodeServer
2. 每个用户可以自己修改登录密码
3. 每个用户的Python环境完全隔离，可独立安装pip包
4. 用户间不应该能互相访问到对方的文件
5. 防止用户误操作删掉系统关键组件
6. 防止用户误操作写出死循环之类的耗尽服务器资源
7. 防止用户利用服务器挖矿/做跳板攻击别人

经过分析和与ai的讨论，最终定下来的方案大致是这样：
1. 利用Linux自己的多用户机制，每个用户在自己的家目录下运行一个CodeServer做最基础的隔离。这样需求145可以很轻松的实现；  
2. 监听端口根据uid计算。每个用户下手动创建一个venv，并通过.bashrc让用户启动shell的时候自动启用，解决需求3；  
3. 利用systemd的限制来限制进程的行为，实现一定程度上实现需求6-7
4. 利用systemd的Path机制监听`$HOME/.config/code-server/config.yaml`的修改并自动重启daemon，使得用户可以通过修改配置文件来改登录密码，较为优雅地实现需求2。

~~对于7，我觉得根据大一同学的计算机水平倒是不用太担心（应该吧？）~~  
没有直接断网是因为考虑到有些需求需要联网下软件包，或者可能涉及到爬虫操作什么的。systemd的限制应该已经能拦截绝大部分恶意操作了。  
本文讨论不涉及SELinux，因为个人认为当前需求使用SELinux有点过度设计了，并且我也对SELinux/SEPolicy不太熟（这才是主要原因吧233），同时也想尽量让用户在合理使用过程中不受限制，因此并未使用SELinux来限制。
# 部署
## 配置systemd
下载下来codeserver二进制文件传到服务器上，比如我丢在`/usr/bin/code-server`。然后编写systemd配置，创建`/etc/systemd/system/code-server@.service`：

```toml
# /etc/systemd/system/code-server@.service
[Unit]
Description=Code-Server for %i
After=network.target

[Service]
Type=simple
User=%i
Group=%i
WorkingDirectory=/home/%i
MemoryMax=1G
CPUQuota=150%
TasksMax=200
IOWeight=50
ProtectSystem=strict
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
# ExecStart=/bin/bash -c "PASSWORD=$(echo -n "%i" | md5sum | cut -d' ' -f1) /usr/bin/code-server --bind-addr 0.0.0.0:$((7000 + $(id -u %i))) --auth password"
ExecStart=/bin/bash -c ' \
    PORT=$((7000 + $(id -u %i) %% 10000)); \
    /usr/bin/code-server --bind-addr 0.0.0.0:$PORT; \
    '
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```
这里创建的文件名是`code-server@.service`，`@`之后的内容会被当作`%i`替换。设计上是利用`%i`传递用户名称，计算端口并自启动。端口计算逻辑是`7000+uid%10000`，一般创建的uid是1000开始，因此正好按照创建顺序从8000开始监听端口。  

值得注意的是这部分配置：
```toml
MemoryMax=1G
CPUQuota=150%
TasksMax=200
IOWeight=50
ProtectSystem=strict
PrivateTmp=yes
PrivateDevices=yes
NoNewPrivileges=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
```
（我懒得解释了，让ai解释一下吧）
它主要分为两个方面：**资源限制（Resource Control）** 和 **安全沙盒隔离（Security and Sandboxing）**。
### 一、 资源限制 (Resource Control)
这部分利用 Linux 的 cgroups 机制，防止该服务消耗过多系统资源，影响其他程序运行。
- **`MemoryMax=1G`**
    - **作用：** 限制该服务最多只能使用 1GB 的内存。
    - **结果：** 如果服务尝试使用的内存超过 1GB，系统（OOM Killer）会强制杀死该进程以保护系统。
- **`CPUQuota=150%`**
    - **作用：** 限制该服务的 CPU 使用率最高为 150%。
    - **结果：** 100% 代表一个完整的 CPU 核心。150% 意味着该服务最多可以占满一个核心，并使用第二个核心的一半（即最多使用 1.5 个 CPU 核心的算力）。
- **`TasksMax=200`**
    - **作用：** 限制该服务可以创建的最大任务（进程或线程）数量为 200 个。
    - **结果：** 防止服务因为遭遇漏洞或死循环（如 Fork Bomb）而无限创建子进程，从而耗尽系统 PID 资源使系统崩溃。
- **`IOWeight=50`**
    - **作用：** 设置磁盘 I/O（输入/输出）的权重。默认值通常是 100。
    - **结果：** 设置为 50 意味着当系统 I/O 繁忙时，该服务获得磁盘读写资源的优先级低于默认服务，防止它在大量读写文件时卡死整个系统。
### 二、 安全与隔离 (Security & Isolation)
这部分通过 Linux 命名空间（Namespaces）和其他内核安全机制，将服务“关在笼子里”，即使服务被黑客攻破，也能将破坏降到最低。
- **`ProtectSystem=strict`**
    - **作用：** 严格保护系统文件。
    - **结果：** 将整个操作系统的文件系统（`/` 根目录及其下的所有内容，除了 `/dev`, `/proc` 和 `/sys` 等特殊 API 目录）对该服务设为**只读**。该服务无法修改、覆盖或删除任何系统核心文件。
- **`PrivateTmp=yes`**
    - **作用：** 为该服务提供独立的临时文件目录。
    - **结果：** 服务会看到一个自己专属的 `/tmp` 和 `/var/tmp` 目录。它无法看到或修改其他用户/服务放在全局 `/tmp` 中的文件，反之亦然。这能有效防止基于临时文件的符号链接攻击或数据泄露。
- **`PrivateDevices=yes`**
    - **作用：** 隔离物理设备。
    - **结果：** 为该服务挂载一个私有的 `/dev` 目录，里面只包含伪设备（如 `/dev/null`, `/dev/zero`, `/dev/urandom` 等）。该服务将**完全看不到**真实的物理硬件设备（如硬盘 `/dev/sda`、USB 设备等），彻底杜绝了直接读写底层块设备的可能。
- **`NoNewPrivileges=yes`**
    - **作用：** 禁止权限提升。
    - **结果：** 确保该服务及其所有子进程，无论如何都无法获得新的系统权限。即使服务调用了一个带有 SUID 位的程序（比如 `sudo` 或 `su`），也无法借此提升为 root 权限。
- **`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`**
    - **作用：** 限制该服务可以使用的网络协议族。
    - **结果：** 该服务只能使用：
        - `AF_INET`：IPv4 网络通信
        - `AF_INET6`：IPv6 网络通信
        - `AF_UNIX`：本地 UNIX 域套接字（用于本地进程间通信）
    - 除此之外的网络协议（例如底层的数据包抓取 `AF_PACKET`、蓝牙 `AF_BLUETOOTH` 等）全部被内核拦截。这大大减少了网络层面的攻击面。

创建新用户时直接：
```shell
adduser <username>
systemctl enable --now code-server@<username>
```
即可同时创建对应的CodeServer服务
## 配置修改密码自动重启
创建文件`/etc/systemd/system/code-server-restart@.path`:
```toml
# /etc/systemd/system/code-server-restart@.path
[Unit]
Description=Monitor code-server config change for %i
After=network.target

[Path]
PathChanged=/home/%i/.config/code-server/config.yaml

[Install]
WantedBy=multi-user.target
```
创建文件`/etc/systemd/system/code-server-restart@.service`：
```toml
[Unit]
Description=Triggered safe restart for %i

[Service]
Type=oneshot
User=root
ExecStart=/usr/local/bin/safe-restart-codeserver.sh %i

[Install]
WantedBy=multi-user.target
```
这里的运行逻辑是这样的：
### 第一步：启动监控 (由 `.path` 文件负责)
1. 系统或管理员启动了`code-server-restart@<username>.path`。
2. systemd会解析这个`.path`文件，将`%i`替换为用户名。
3. **`PathChanged=/home/<username>/.config/code-server/config.yaml`**：systemd 会在内核层面（利用 inotify 机制）开始静默监听这个特定路径的 `config.yaml` 文件。
### 第二步：检测变更并触发
1. 在 code-server 网页端修改了设置，或者通过命令行直接编辑了 `config.yaml` 并保存。
2. `PathChanged` 检测到文件被修改**并且被关闭**（这意味着写入已完成，避免读到写了一半的脏数据）。
3. **隐式绑定：** 因为 `.path` 文件中没有使用 `Unit=` 显式指定要触发哪个服务，systemd 的默认行为是**触发与它同名去掉后缀的 `.service` 文件**。
4. 于是，systemd 自动拉起 `code-server-restart@<username>.service`。
### 第三步：执行动作 (由 `.service` 文件负责)
1. systemd 开始执行 `code-server-restart@<username>.service`。同样，这里的 `%i` 也会被替换为用户名。
2. **`Type=oneshot`**：告诉系统这不是一个常驻后台的服务，而是一次性的任务。执行完就结束。
3. **`User=root`**：这个重启操作需要较高的权限，因此强制以 `root` 身份执行。
4. **`ExecStart=/usr/local/bin/safe-restart-codeserver.sh <user>`**：这是整个逻辑的最终落脚点。系统以 root 身份运行了这个自定义的 shell 脚本，并将用户名作为参数传递给它。

没有直接在restart.service里重启主daemon，因为考虑到CodeServer编辑文件是每修改一点就会自动保存，因此当用户修改密码过程中，可能会存在修改了一半就被触发重启，导致后面的部分没有成功写入的情况，因此编写了一个脚本，判断等文件没有修改之后才触发重启：
`/usr/local/bin/safe-restart-codeserver.sh`
```shell
#!/bin/bash
USER_NAME=$1
CONFIG_FILE="/home/$USER_NAME/.config/code-server/config.yaml"
STAMP_FILE="/tmp/code-server-restart-${USER_NAME}.stamp"

# 1. 前置拦截：如果记录文件存在，且配置文件比记录文件旧（或时间相同）
# 说明这一次触发是 systemd 排队遗留下来的无意义事件，直接退出
if [ -f "$STAMP_FILE" ] && [ "$CONFIG_FILE" -ot "$STAMP_FILE" ]; then
    echo "Config hasn't changed since last restart, exiting."
    exit 0
fi

# 2. 原有的防抖等待逻辑（保持不变）
while true; do
    last_md5=$(md5sum "$CONFIG_FILE")
    sleep 5
    current_md5=$(md5sum "$CONFIG_FILE")
    
    if [ "$last_md5" == "$current_md5" ]; then
        # 文件稳定了，执行重启
        systemctl restart code-server@$USER_NAME
        
        # 3. 关键动作：重启成功后，更新时间戳文件的修改时间
        touch "$STAMP_FILE"
        break
    else
        echo "Config file for $USER_NAME is still changing, waiting..."
    fi
done
```
那个时间戳机制是为了防止多次触发导致无效重启，若检测到配置文件编辑时间早于上次重启时间则拒绝重启。  

完成编辑后启用触发器：`systemd enable --now code-server-restart@<username>.path`（注意是`.path`不是`.service`），接着在web界面中尝试缓慢编辑config文件中的密码，查看日志就可以发现类似于如下记录：
```plain
○ code-server-restart@lyr.service - Triggered safe restart for lyr
     Loaded: loaded (/etc/systemd/system/code-server-restart@.service; disabled; preset: enabled)
     Active: inactive (dead) since Sat 2026-06-06 06:43:55 UTC; 29s ago
 Invocation: 0bd37fcb6ea44a58870c06b4fde5300c
TriggeredBy: ● code-server-restart@lyr.path
    Process: 6997 ExecStart=/usr/local/bin/safe-restart-codeserver.sh lyr (code=exited, status=0/SUCCESS)
   Main PID: 6997 (code=exited, status=0/SUCCESS)
   Mem peak: 2.5M
        CPU: 43ms

Jun 06 06:43:40 CodeServer systemd[1]: Starting code-server-restart@lyr.service - Triggered safe restart for lyr...
Jun 06 06:43:45 CodeServer safe-restart-codeserver.sh[6997]: Config file for lyr is still changing, waiting...
Jun 06 06:43:50 CodeServer safe-restart-codeserver.sh[6997]: Config file for lyr is still changing, waiting...
Jun 06 06:43:55 CodeServer systemd[1]: code-server-restart@lyr.service: Deactivated successfully.
Jun 06 06:43:55 CodeServer systemd[1]: Finished code-server-restart@lyr.service - Triggered safe restart for lyr.
```
当停止编辑5秒之后CodeServer才会重启，后续可以使用新密码登录。
## 配置Python venv
首先系统里需要安装Python3，这就不多赘述了，包管理器直接装即可。同时安装一个`python3-venv`：
```shell
apt install python3-venv
```
接着，进入用户的家目录，我选择创建了一个名为`.venv`的文件夹用于存放虚拟环境。在`.venv`中执行`python3 -m venv myvenv`创建一个名叫`myvenv`的虚拟环境，并在用户的`.bashrc`后加上一行：
```diff
  fi
fi

+source ~/.venv/myvenv/bin/activate
```
之后，启动shell的时候就会自动启用venv。

## 为CodeServer安装Python插件并指派使用venv
这一步就不过多赘述了，在网页上给CodeServer安装Python和调试器插件，并指定Python解释器为venv下的python即可。


---
# 后记
其实这个配置很早就做了但是一直没写，当时还没爆出来CopyFail和DirtyFrag这样的漏洞。爆出来的时候第一时间做了测试，发现这套systemd配置阴差阳错的全都防住了，大致分析如下：
因为CopyFail使用了一个特殊的套接字类型：`AF_ALG`，而systemd配置只允许`AF_INET AF_INET6 AF_UNIX`这三种，因此CopyFail无法提权。DirtyFrag也是同理，其利用的`AF_NETLINK`、`AF_RXRPC`、`AF_ALG`都被禁止了。  
同时，`NoNewPrivileges=yes`也是最后的防线，代码的最终目标是篡改`/usr/bin/su`植入恶意ELF shellcode或篡改`/etc/passwd`清空root密码，随后调用具有`setuid`权限的`su`命令来获取 root 权限。而`NoNewPrivileges`一旦设置，该进程及其派生的所有子进程，无论执行什么程序，都**绝对无法**通过文件的`setuid`或`setgid`标志获得更高的权限。退一万步讲，即使后续有漏洞找到了某种手段绕过了网络限制，并成功将`/usr/bin/su`替换成了恶意Shell，当它执行`su`时，弹出来的依然是一个低权限用户的Shell，提权彻底沦为空谈。

本文没有讨论SELinux，因为当前方案在“朋友共用、非生产核心”的场景下是可接受的简化，避免了配置错误导致功能不可用的风险和运维复杂度，但实际上systemd的这些沙盒选项主要基于namespace和cgroup隔离，并不能完全替代强制访问控制（也就是SELinux和AppArmor这类ACL），对于需要更高安全等级的租户隔离（如不可信用户之间需防止内核漏洞逃逸），SELinux/AppArmor仍然是主流。
当然，这个方案也存在其他一些局限，比如当用户非常多，或者uid分配有特殊需求，超过10000时原先计算端口的方式可能会失效；对于科学计算等其他正常需求，目前的限制可能过于严格等。本文仅作为一种思路探讨和参考。

_碎碎念：在容器化和云原生的时代，传统systemd还有很多值得我们去探求的特性可以做到很多事情呢……_

---
参考文章：
1. [systemd.git - A fork of systemd to make components more independant](https://git.parabola.nu/~lukeshu/systemd.git/log/man?id=6b3d378331fe714c7bf2263eaa9a8b33fc878e7c&ofs=200&showmsg=1)