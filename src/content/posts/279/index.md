---
title: "充分利用systemd的特性构建多租户CodeServer"
published: 2026-06-06T07:34:00.000Z
updated: 2026-06-06T07:36:04.000Z
description: "为朋友共用的服务器部署按用户运行的 code-server，用 systemd 限制资源、监听密码配置变化，并为每个用户配置 Python venv，讨论这套方案的隔离边界。"
image: ""
tags: ["systemd", "codeserver"]
category: "运维"
categories: ["运维", "网络安全"]
draft: false
lang: "zh_CN"
---

# 分析
起因是大学Python课，不想每次课都带笔记本过去太重了，尝试能不能一个平板就搞定。找来找去发现[coder/code-server: VS Code in the browser](https://github.com/coder/code-server)很符合要求，同时还能兼顾跨平台。当时自己部署了一个玩玩，后来朋友他们也想要，就在思考怎么弄能够兼顾多用户使用和安全性。最开始考虑过容器化，后来想先用 Linux 用户和 venv 管理各自的文件与 Python 包，就选择了二进制部署。这里没有做容器和直接部署的性能对比。  
需求很简单，大致概括如下：
1. 每个用户可以用自己的域名登录进入CodeServer
2. 每个用户可以自己修改登录密码
3. 每个用户有独立的 Python 包环境，可自行安装 pip 包
4. 用户间不应该能互相访问到对方的文件
5. 防止用户误操作删掉系统关键组件
6. 防止用户误操作写出死循环之类的耗尽服务器资源
7. 防止用户利用服务器挖矿/做跳板攻击别人

经过分析和与ai的讨论，最终定下来的方案大致是这样：
1. 利用 Linux 多用户机制，每个用户在自己的家目录下运行一个 CodeServer，通过文件所有权和权限限制互相访问。家目录应设置为仅本人可访问（如 `0700`），仅仅创建不同用户并不会自动隐藏所有文件；域名接入还需要另外配置反向代理。  
2. 监听端口根据uid计算。每个用户下手动创建一个venv，并通过.bashrc让用户启动shell的时候自动启用，解决需求3；  
3. 利用 systemd 限制资源占用和部分进程行为，减少误操作的影响。这不能阻止所有挖矿或滥用网络的行为。
4. 利用systemd的Path机制监听`$HOME/.config/code-server/config.yaml`的修改并自动重启daemon，使得用户可以通过修改配置文件来改登录密码，较为优雅地实现需求2。

~~对于7，我觉得根据大一同学的计算机水平倒是不用太担心（应该吧？）~~  
没有直接断网是因为考虑到有些需求需要联网下软件包，或者可能涉及到爬虫操作什么的。目前仍允许普通 IPv4/IPv6 出站连接，因此这些限制不能代替出站访问控制和对滥用行为的管理。  
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
ReadWritePaths=/home/%i
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

`ProtectSystem=strict` 会让家目录也变成只读，因此用 `ReadWritePaths=/home/%i` 显式允许当前用户的工作目录写入。这个选项不会授予额外的文件权限，仍需正确设置家目录的所有权和权限。venv 只用于分开管理 Python 包，不是阻止用户访问宿主机或其他文件的安全沙盒。

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
    - **作用：** 将该服务所在 cgroup 的内存使用上限设为 1 GiB。
    - **结果：** 当服务所在 cgroup 的内存使用达到限制且无法通过回收缓解时，可能触发该组内的 OOM 处理。`1G` 在这里表示 1 GiB。
- **`CPUQuota=150%`**
    - **作用：** 限制该服务的 CPU 使用率最高为 150%。
    - **结果：** 100% 代表一个完整的 CPU 核心。150% 意味着该服务最多可以占满一个核心，并使用第二个核心的一半（即最多使用 1.5 个 CPU 核心的算力）。
- **`TasksMax=200`**
    - **作用：** 限制该服务可以创建的最大任务（进程或线程）数量为 200 个。
    - **结果：** 防止服务因为遭遇漏洞或死循环（如 Fork Bomb）而无限创建子进程，从而耗尽系统 PID 资源使系统崩溃。
- **`IOWeight=50`**
    - **作用：** 设置磁盘 I/O（输入/输出）的权重。默认值通常是 100。
    - **结果：** 在底层设备和 I/O 控制器支持权重调度时，设置为 50 会降低它在竞争中的相对份额。这不是固定的读写速率上限，也不能保证其他服务不受影响。
### 二、 安全与隔离 (Security & Isolation)
这部分限制服务对文件系统、设备和套接字的访问，用于减少误操作的影响及部分攻击路径。
- **`ProtectSystem=strict`**
    - **作用：** 严格保护系统文件。
    - **结果：** 将文件系统层级设为只读，特殊 API 文件系统及显式配置的可写路径除外。这里通过 `ReadWritePaths` 保留用户家目录的写入能力；这种挂载限制不能替代内核漏洞修补。
- **`PrivateTmp=yes`**
    - **作用：** 为该服务提供独立的临时文件目录。
    - **结果：** 服务会看到一个自己专属的 `/tmp` 和 `/var/tmp` 目录。它无法看到或修改其他用户/服务放在全局 `/tmp` 中的文件，反之亦然。这能有效防止基于临时文件的符号链接攻击或数据泄露。
- **`PrivateDevices=yes`**
    - **作用：** 隔离物理设备。
    - **结果：** 为服务提供一个只含必要伪设备的私有 `/dev`，例如 `/dev/null`、`/dev/zero` 和 `/dev/urandom`，限制直接访问宿主机设备节点。这不等于隔离了所有可能的硬件访问路径。
- **`NoNewPrivileges=yes`**
    - **作用：** 限制通过执行新程序获得额外权限。
    - **结果：** 服务及其子进程不能通过 `execve()` 利用 setuid/setgid 位或文件 capabilities 获得额外权限。它不能防住所有提权方式，例如直接利用内核漏洞修改进程凭据。
- **`RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`**
    - **作用：** 限制该服务可以使用的网络协议族。
    - **结果：** 允许创建以下地址族的套接字：
        - `AF_INET`：IPv4 网络通信
        - `AF_INET6`：IPv6 网络通信
        - `AF_UNIX`：本地 UNIX 域套接字（用于本地进程间通信）
    - 在支持相应 seccomp 过滤的环境中，创建其他地址族套接字的调用会被限制。这可以缩小攻击面，但不限制 IPv4/IPv6 的连接目标，也不会撤销已经继承或传入的套接字。

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
其实这个配置很早就做了但是一直没写，当时还没爆出来 CopyFail 和 DirtyFrag 这样的漏洞。披露后，我在这套配置下运行了当时拿到的 PoC，测试中没有成功提权。这是对当时环境和样本的观察，不能推广为能防住所有相关变种。

从测试样本看，利用链需要创建 `AF_ALG`，或 `AF_NETLINK`、`AF_RXRPC` 等套接字，而这里的 `RestrictAddressFamilies` 没有允许这些地址族，因此可能在套接字创建阶段阻断这些利用路径。要确认具体阻断点，还需要结合对应 PoC、内核版本和系统日志分析。

`NoNewPrivileges=yes` 则限制了另一类路径：进程及其子进程不能在 `execve()` 时通过 setuid/setgid 位或文件 capabilities 获得额外权限。但它不阻止所有不经过 `execve()` 的权限变化，也不能保证受损的系统文件不会影响其他高权限进程。因此，系统及时更新仍然必要，不能用这套配置代替漏洞修补。

本文没有展开 SELinux，当前方案主要面向朋友共用、非关键业务的环境。systemd 的这些选项结合了 namespace、cgroup 和 seccomp 等机制，但不是完整的租户安全边界。SELinux/AppArmor 可以进一步限制进程访问，也不能保证挡住所有内核漏洞；面对互不信任的用户，还需要根据威胁模型评估更强的隔离方式。
当然，这个方案也存在其他一些局限，比如当用户非常多，或者uid分配有特殊需求，超过10000时原先计算端口的方式可能会失效；对于科学计算等其他正常需求，目前的限制可能过于严格等。本文仅作为一种思路探讨和参考。

_碎碎念：在容器化和云原生的时代，传统systemd还有很多值得我们去探求的特性可以做到很多事情呢……_

---
参考文章：
1. [systemd.git - A fork of systemd to make components more independant](https://git.parabola.nu/~lukeshu/systemd.git/log/man?id=6b3d378331fe714c7bf2263eaa9a8b33fc878e7c&ofs=200&showmsg=1)
2. [systemd.exec：服务执行环境与沙盒选项](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
3. [Linux 内核文档：No New Privileges Flag](https://docs.kernel.org/userspace-api/no_new_privs.html)