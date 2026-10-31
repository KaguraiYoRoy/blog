---
title: "跨平台服务编写日记 Ep.1 统一的日志管理"
published: 2025-04-18T16:19:00.000Z
updated: 2025-06-27T03:28:21.000Z
description: "本文详细讲解如何用C++实现跨平台多线程日志系统，通过BlockingQueue阻塞队列保障线程安全，支持日志分级和文件/控制台双输出，提供std::thread与mutex的实战应用示例，包含Windows/Linux时间戳获取、va_list格式化消息等关键实现细节，适合需要构建高性能日志模块的开发者参考。"
image: "./images/2025/04/3664149349.jpg"
tags: ["C&C++", "Linux", "Windows", "编程", "MSVC", "STL", "服务"]
category: "开发"
draft: false
lang: "zh_CN"
---

前阵子心血来潮，想为在使用的一个跨平台的控制台服务类应用程序编写一个自己的管理程序，加一些功能。因而设计了一套简单的服务运行流程。

:::warning
本系列文章中的观点和方案为我根据自己已有的知识储备结合DeepSeek的帮助所归纳设计，并未经过严格测试，并不保证在生产环境中使用的可行性和稳定性
:::

# 大致思路
大致分为个线程，分别用作：
1. 日志记录
2. 目标应用实例管理，可能不止一个线程
3. 监听IPC消息
4. 处理IPC收到的消息（主进程）

本文着重讨论的是日志记录部分。

# 编写思路
为什么要给日志记录单开一个线程，个人考虑是因为本身就是多线程的架构，需要编写一个统一的日志记录模块。如果每个线程单独打印，则很有可能出现两个线程同时写入文件或者同时输出到控制台，造成日志混乱。  

因此，日志记录大致思路就是：
1. 定义一个队列，存储日志内容和等级
2. 创建一个线程，不断地从线程中取出元素，根据设定的日志等级决定是否打印到控制台或者输出到文件
3. 外部push日志内容到队列中

## 一些细节上的内容
* 保证可移植性，尽量使用STL库编写，如使用`std::thread`而不是`pthread`
* 保证线程安全，需要使用互斥锁之类的保护相应变量
* 让日志队列为空时线程等待，想到编写一个类似于Java下BlockingQueue的阻塞队列
* 指定一个日志等级，超过这个等级的日志才会被保存或者打印
* 通过`va_list`实现不定参数，使日志记录有`sprintf`的的使用体验

# 开始编写

有了上述思路，整体编写就很简单了。

## BlockingQueue
~~偷懒了，这部分直接让DeepSeek写的~~
为了实现一个多线程安全的阻塞队列，当队列为空时调用`front()`会阻塞直到其他线程添加元素，我们可以结合互斥锁（`std::mutex`）和条件变量（`std::condition_variable`）来同步线程操作。
### 代码实现
#### 互斥锁（`std::mutex`）
所有对队列的操作（`push`、`front`、`pop`、`empty`）都需要先获取锁，确保同一时间只有一个线程能修改队列，避免数据竞争。

#### 条件变量（`std::condition_variable`）
* 当调用`front()`时，如果队列为空，线程会通过`cv_.wait()`释放锁并阻塞，直到其他线程调用`push()`添加元素后，通过`cv_.notify_one()`唤醒一个等待线程。  
* `cv_.wait()`需配合`std::unique_lock`，并在等待时自动释放锁，避免死锁。    
* 使用谓词检查（`[this] { return !queue_.empty(); }`）防止虚假唤醒。  

#### 元素获取与移除
* `front()`返回队首元素的拷贝（而非引用），确保调用者获得数据时队列的锁已释放，避免悬空引用。  
* `pop()`需显式调用以移除元素，确保队列状态可控。


```cpp
#include <queue>              // 队列
#include <mutex>              // 互斥锁
#include <condition_variable> // 条件变量

template<typename T>
class BlockingQueue {
public:
    // 向队列中添加元素
    void push(const T& item) {
        std::lock_guard<std::mutex> lock(mtx_);
        queue_.push(item);
        cv_.notify_one(); // 通知一个等待的线程
    }

    // 获取队首元素（阻塞直到队列非空）
    T front() {
        std::unique_lock<std::mutex> lock(mtx_);
        cv_.wait(lock, [this] { return !queue_.empty(); }); // 阻塞直到队列非空
        return queue_.front();
    }

    // 获取队首元素并移除
    T take() {
        std::unique_lock<std::mutex> lock(mtx_);
        cv_.wait(lock, [this] { return !queue_.empty(); });
        T item = std::move(queue_.front()); // 移动语义避免拷贝
        queue_.pop();
        return item;
    }

    // 移除队首元素（需外部调用，非阻塞）
    void pop() {
        std::lock_guard<std::mutex> lock(mtx_);
        if (!queue_.empty()) {
            queue_.pop();
        }
    }

    // 检查队列是否为空
    bool empty() const {
        std::lock_guard<std::mutex> lock(mtx_);
        return queue_.empty();
    }

private:
    mutable std::mutex mtx_;         // 互斥锁
    std::condition_variable cv_;     // 条件变量
    std::queue<T> queue_;            // 内部队列
};
```

## Log类
### Log.h

```cpp
#pragma once
#include <iostream>
#include <fstream>
#include <cstring>
#include <thread>
#include <chrono>
#include <mutex>
#include <cstdio>
#include <cstdarg>
#include <atomic>

#include "BlockingQueue.h"

enum LogLevel {
	LEVEL_VERBOSE,LEVEL_INFO,LEVEL_WARN,LEVEL_ERROR,LEVEL_FATAL,LEVEL_OFF
};

struct LogMsg {
	short m_LogLevel;
	std::string m_strTimestamp;
	std::string m_strLogMsg;
};

class Log {
private:
	std::ofstream m_ofLogFile;        // 日志文件输出流
	std::mutex m_lockFile;            // 文件操作互斥锁
	std::thread m_threadMain;         // 后台日志处理线程
	BlockingQueue<LogMsg> m_msgQueue; // 线程安全阻塞队列
	short m_levelLog, m_levelPrint;   // 文件和控制台日志级别阈值
	std::atomic<bool> m_exit_requested{ false }; // 线程退出标志

	std::string getTime();            // 获取当前时间戳
	std::string level2str(short level, bool character_only); // 级别转字符串
	void logThread();                 // 后台线程函数

public:
	Log(short default_loglevel = LEVEL_WARN, short default_printlevel = LEVEL_INFO);
	~Log();
	void push(short level, const char* msg, ...); // 添加日志（支持格式化）
	void set_level(short loglevel, short printlevel); // 设置日志级别
	bool open(std::string filename);   // 打开日志文件
	bool close();                      // 关闭日志文件
};

```

### Log.cpp
```cpp
#include "Log.h"

std::string Log::getTime() {
	using sc = std::chrono::system_clock;
	std::time_t t = sc::to_time_t(sc::now());
	char buf[20];
#ifdef _WIN32
	std::tm timeinfo;
	localtime_s(&timeinfo,&t);
	sprintf_s(buf, "%04d.%02d.%02d-%02d:%02d:%02d", 
		timeinfo.tm_year + 1900,
		timeinfo.tm_mon + 1,
		timeinfo.tm_mday,
		timeinfo.tm_hour,
		timeinfo.tm_min,
		timeinfo.tm_sec
	);
#else
	strftime(buf, 20, "%Y.%m.%d-%H:%M:%S", localtime(&t));
#endif
	return buf;
}

std::string Log::level2str(short level, bool character_only)
{
	switch (level) {
	case LEVEL_VERBOSE: 
		return character_only ? "V" : "Verbose";
	case LEVEL_WARN:
		return character_only ? "W" : "Warning";
	case LEVEL_ERROR:
		return character_only ? "E" : "Error";
	case LEVEL_FATAL:
		return character_only ? "F" : "Fatal";
	}
	return character_only ? "I" : "Info";
}

void Log::logThread() {
	while (true) {
		LogMsg front = m_msgQueue.take(); // 阻塞直到有消息
		// 处理文件写入
		if (front.m_LogLevel >= m_levelLog) {
			std::lock_guard<std::mutex> lock(m_lockFile); // RAII 管理锁
			if (m_ofLogFile) {
				m_ofLogFile << front.m_strTimestamp << ' '
					<< level2str(front.m_LogLevel, true) << ": "
					<< front.m_strLogMsg << std::endl;
			}
		}
		// 处理控制台打印
		if (front.m_LogLevel >= m_levelPrint) {
			printf("%s %s: %s\n", front.m_strTimestamp.c_str(),
				level2str(front.m_LogLevel, true).c_str(),
				front.m_strLogMsg.c_str());
		}
		// 检查退出条件：队列为空且标志为真
		if (m_exit_requested.load() && m_msgQueue.empty()) break;
	}
	return;
}

Log::Log(short default_loglevel, short default_printlevel) {
	set_level(default_loglevel, default_printlevel);
	m_threadMain = std::thread(&Log::logThread, this);
}

Log::~Log() {
	m_exit_requested.store(true);
	m_msgQueue.push({ LEVEL_INFO, getTime(), "Exit." }); // 唤醒可能阻塞的线程
	if (m_threadMain.joinable()) m_threadMain.join();
	close(); // 确保文件关闭
}

void Log::push(short level, const char* msg, ...) {
	va_list args;
	va_start(args, msg);
	const int len = vsnprintf(nullptr, 0, msg, args);
	va_end(args);

	if (len < 0) return;

	std::vector<char> buf(len + 1);

	va_start(args, msg);
	vsnprintf(buf.data(), buf.size(), msg, args);
	va_end(args);

	m_msgQueue.push({level,getTime(),buf.data()});
}

void Log::set_level(short loglevel, short printlevel)
{
	m_levelLog = loglevel;
	m_levelPrint = printlevel;
}

bool Log::open(std::string filename) {
	m_lockFile.lock();
	m_ofLogFile.open(filename.c_str(), std::ios::out);
	m_lockFile.unlock();
	return (bool)m_ofLogFile;
}

bool Log::close() {
	m_lockFile.lock();
	m_ofLogFile.close();
	m_lockFile.unlock();
	return false;
}
```

### 说明
#### 类/结构说明
1. LogLevel 枚举
定义日志级别：VERBOSE, INFO, WARN, ERROR, FATAL, OFF。
OFF不应被用于记录的日志等级，仅用于当需要关闭日志记录时将阈值设置为该项以实现所有日志都不记录
3. LogMsg 结构体
封装日志消息：
  * m_LogLevel：日志级别。
  * m_strTimestamp：时间戳字符串。
  * m_strLogMsg：日志内容。

#### 成员变量说明
| 变量 | 说明 |
| ---- | ---- |
| m_ofLogFile | 文件输出流，用于写入日志文件。 |
| m_lockFile | 互斥锁，保护文件操作。 |
| m_threadMain | 后台线程，处理日志消息的消费。 |
| m_msgQueue | 阻塞队列，存储待处理的日志消息。 |
| m_levelLog | 写入文件的最低日志级别（高于此级别的消息会被记录）。 |
| m_levelPrint | 打印到控制台的最低日志级别。 |
| m_exit_requested | 原子标志，控制日志线程退出。 |

#### 函数说明
| 函数 | 说明 |
| ---- | ---- |
| getTime | 获取当前时间戳字符串（跨平台实现）。 |
| level2str | 将日志级别转换为字符串（如 LEVEL_INFO → "I" 或 "Info"）。 |
| logThread | 后台线程函数：消费队列消息，写入文件或打印。 |
| 构造函数 | 初始化日志级别，启动后台线程。 |
| 析构函数 | 设置退出标志，等待线程结束，确保处理剩余消息。 |
| push | 格式化日志消息（支持可变参数）并推入队列。 |
| set_level | 动态设置日志级别和打印级别。 |
| open/close | 打开/关闭日志文件。 |

-----

完整代码及测试样例下载：
[demo.zip](/downloads/2025/04/3361655567.zip)
