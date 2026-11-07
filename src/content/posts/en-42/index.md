---
title: "Cross-Platform Service Programming Diary Ep.1 - Unified Logging Management"
published: 2025-04-18T16:19:00.000Z
updated: 2025-11-22T09:20:45.000Z
description: "本文详细讲解如何用C++实现跨平台多线程日志系统，通过BlockingQueue阻塞队列保障线程安全，支持日志分级和文件/控制台双输出，提供std::thread与mutex的实战应用示例，包含Windows/Linux时间戳获取、va_list格式化消息等关键实现细节，适合需要构建高性能日志模块的开发者参考。"
image: ""
tags: ["C&C++", "Linux", "Windows", "Programming", "MSVC", "STL", "Services"]
category: "Develop"
categories: ["Develop"]
draft: false
lang: "en_US"
---

A while ago, on a whim, I decided to write my own management program for a cross-platform console service-class application I was using, in order to add some features. Thus, I designed a simple service operation flow.

:::warning
The views and solutions in this series of articles are designed by me based on my existing knowledge combined with assistance from DeepSeek. They have not been rigorously tested and do not guarantee feasibility or stability for use in production environments.
:::

# General Approach
Roughly divided into several threads, used for:
1. Logging
2. Target application instance management (potentially more than one thread)
3. Listening for IPC messages
4. Processing received IPC messages (main process)

This article focuses on the logging part.

# Design Rationale
Why dedicate a separate thread to logging? My consideration is that since it's inherently a multi-threaded architecture, a unified logging module is necessary. If each thread prints independently, it's highly likely that two threads could write to the file or output to the console simultaneously, causing log chaos.  

Therefore, the general idea for logging is:
1. Define a queue to store log content and level.
2. Create a thread that continuously takes elements from the queue, deciding whether to print to the console or output to a file based on the set log level.
3. External components push log content to the queue.

## Some Detailed Considerations
* Ensure portability by using the STL library as much as possible, e.g., using `std::thread` instead of `pthread`.
* Ensure thread safety, requiring protection of relevant variables with mutexes or similar mechanisms.
* Make the thread wait when the log queue is empty; thought of writing a blocking queue similar to Java's BlockingQueue.
* Specify a log level; only logs with a level meeting or exceeding this threshold will be saved or printed.
* Implement variadic arguments via `va_list` to give the logging function a usage experience similar to `sprintf`.

# Start Coding

With the above approach, the overall coding becomes quite simple.

## BlockingQueue
~~Got lazy here, let DeepSeek write this part directly~~
To implement a multi-thread-safe blocking queue where calling `front()` blocks until another thread adds an element, we can combine a mutex (`std::mutex`) and a condition variable (`std::condition_variable`) to synchronize thread operations.

### Code Implementation
#### Mutex (`std::mutex`)
All operations on the queue (`push`、`front`、`pop`、`empty`) need to acquire the lock first, ensuring only one thread can modify the queue at a time and avoiding data races.  

#### Condition Variable (`std::condition_variable`)
* When `front()` is called and the queue is empty, the thread releases the lock and blocks via `cv_.wait()`, until another thread calls `push()` to add an element and wakes up one waiting thread via `cv_.notify_one()`.
* `cv_.wait()` needs to be used with `std::unique_lock` and automatically releases the lock while waiting to avoid deadlocks.   
* Uses a predicate check (`[this] { return !queue_.empty(); }`) to prevent spurious wakeups.

#### Element Retrieval and Removal
* `front()` returns a copy of the front element (not a reference), ensuring the caller gets the data after the queue's lock is released, avoiding dangling references.
* `pop()` must be called explicitly to remove the element, ensuring controllable queue state.


```cpp
#include <queue>              // queue
#include <mutex>              // mutex
#include <condition_variable> // condition_variable

template<typename T>
class BlockingQueue {
public:
    // Add an element to the queue
    void push(const T& item) {
        std::lock_guard<std::mutex> lock(mtx_);
        queue_.push(item);
        cv_.notify_one(); // Notify one waiting thread
    }

    // Get the front element (blocks until queue is not empty)
    T front() {
        std::unique_lock<std::mutex> lock(mtx_);
        cv_.wait(lock, [this] { return !queue_.empty(); }); // Block until queue not empty
        return queue_.front();
    }

    // Get and remove the front element
    T take() {
        std::unique_lock<std::mutex> lock(mtx_);
        cv_.wait(lock, [this] { return !queue_.empty(); });
        T item = std::move(queue_.front()); // Use move semantics to avoid copy
        queue_.pop();
        return item;
    }

    // Remove the front element (requires external call, non-blocking)
    void pop() {
        std::lock_guard<std::mutex> lock(mtx_);
        if (!queue_.empty()) {
            queue_.pop();
        }
    }

    // Check if the queue is empty
    bool empty() const {
        std::lock_guard<std::mutex> lock(mtx_);
        return queue_.empty();
    }

private:
    mutable std::mutex mtx_;         // Mutex
    std::condition_variable cv_;     // Condition variable
    std::queue<T> queue_;            // Internal queue
};
```

## Log Class
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
	std::ofstream m_ofLogFile;        // Log file output stream
	std::mutex m_lockFile;            // File operation mutex
	std::thread m_threadMain;         // Background log processing thread
	BlockingQueue<LogMsg> m_msgQueue; // Thread-safe blocking queue
	short m_levelLog, m_levelPrint;   // File and console log level thresholds
	std::atomic<bool> m_exit_requested{ false }; // Thread exit flag

	std::string getTime();            // Get current timestamp
	std::string level2str(short level, bool character_only); // Level to string
	void logThread();                 // Background thread function

public:
	Log(short default_loglevel = LEVEL_WARN, short default_printlevel = LEVEL_INFO);
	~Log();
	void push(short level, const char* msg, ...); // Add log (supports formatting)
	void set_level(short loglevel, short printlevel); // Set log levels
	bool open(std::string filename);   // Open log file
	bool close();                      // Close log file
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
		LogMsg front = m_msgQueue.take(); // Block until a message arrives
		// Handle file writing
		if (front.m_LogLevel >= m_levelLog) {
			std::lock_guard<std::mutex> lock(m_lockFile); // RAII manage lock
			if (m_ofLogFile) {
				m_ofLogFile << front.m_strTimestamp << ' '
					<< level2str(front.m_LogLevel, true) << ": "
					<< front.m_strLogMsg << std::endl;
			}
		}
		// Handle console printing
		if (front.m_LogLevel >= m_levelPrint) {
			printf("%s %s: %s\n", front.m_strTimestamp.c_str(),
				level2str(front.m_LogLevel, true).c_str(),
				front.m_strLogMsg.c_str());
		}
		// Check exit condition: queue is empty and flag is true
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
	m_msgQueue.push({ LEVEL_INFO, getTime(), "Exit." }); // Wake potentially blocked thread
	if (m_threadMain.joinable()) m_threadMain.join();
	close(); // Ensure file is closed
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

### Explanation
#### Class/Structure Explanation
1. LogLevel Enum
Defines log levels: VERBOSE, INFO, WARN, ERROR, FATAL, OFF。
OFF should not be used as a level for recorded logs, only for setting the threshold when needing to disable all logging.
3. LogMsg Struct
Encapsulates a log message:
  * `m_LogLevel`: The log level.
  * `m_strTimestamp`: Timestamp string.
  * `m_strLogMsg`: The log content.

#### Member Variable Explanation
| Variable | Explanation |
| ---- | ---- |
| `m_ofLogFile` | File output stream for writing to the log file. |
| `m_lockFile` | Mutex protecting file operations. |
| `m_threadMain` | Background thread handling consumption of log messages. |
| `m_msgQueue` | Blocking queue storing pending log messages. |
| `m_levelLog` | Minimum log level for writing to file (messages with level >= this are recorded). |
| `m_levelPrint` | Minimum log level for printing to console. |
| `m_exit_requested` | Atomic flag controlling log thread exit. |

#### Function Explanation
| Function | Explanation |
| ---- | ---- |
| `getTime` | Gets the current timestamp string (cross-platform implementation). |
| `level2str` | Converts log level to string (e.g., LEVEL_INFO → "I" or "Info"). |
| `logThread` | Background thread function: consumes queue messages, writes to file or prints. |
| Constructor | Initializes log levels, starts the background thread. |
| Destructor | Sets exit flag, waits for thread to finish, ensures remaining messages are processed. |
| `push` | Formats log message (supports variadic arguments) and pushes to the queue. |
| `set_level` | Dynamically sets the log and print levels. |
| `open`/`close` | Opens/closes the log file. |

-----

Complete code and test sample download:
[demo.zip](/downloads/2025/04/3361655567.zip)
