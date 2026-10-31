---
title: "C++使用WINAPI查询DNS解析记录"
published: 2025-03-20T09:33:00.000Z
updated: 2026-02-21T09:00:47.000Z
description: "C++使用WINAPI查询DNS解析记录"
image: ""
tags: ["C&C++", "Windows", "MSVC"]
category: "开发"
categories: ["开发"]
draft: false
lang: "zh_CN"
---

~~这篇文章是古早时期的博客上迁移过来的（什么赛博秽土转生），~~ 如有错误欢迎指正

# 时间线



- 2022年7月5日：于旧博客上发布，可在archive.org找到


- 2025年3月20日：迁移至当前博客


- 2026年2月21日：添加头文件和静态库文件链接提醒



# 背景
为API配置了多条访问线路，以应对部分地区无法访问导致服务不可用的情况。开始是想到在网站里新建一个文件保存节点信息，发现行不通，联不通的地区根本无法获知其他线路；于是想到用DNS解析记录，用一个TXT解析记录来保存相应的节点数据，以备查询

# 实战
## 查询资料
一番Bing下来，发现大部分现有的文章都是使用socket来直接发送查询数据包，获取到的也都是A和CNAME类型的记录，方案不可行。最后，把目光锁定到了MSDN上的DnsQuery函数上，同时找到一篇样例：[使用DnsQuery解析主机名](https://learn.microsoft.com/zh-cn/previous-versions/troubleshoot/windows/win32/use-dnsquery-resolve-host-names)

## 函数分析
从官方文档上得知，函数所需头文件为windns.h，需要包含引入库文件Ws2_32.lib和Dnsapi.lib，函数的参数如下：  

```cpp
DNS_STATUS DnsQuery_A(
  [in]                PCSTR       pszName,
  [in]                WORD        wType,
  [in]                DWORD       Options,
  [in, out, optional] PVOID       pExtra,
  [out, optional]     PDNS_RECORD *ppQueryResults,
  [out, optional]     PVOID       *pReserved
);
```

参数解释：
* `pszName`是要查询的主机名；
* `wType`是查询类型，如A记录，CNAME，TXT等，具体的MSDN官方给出了文档：[DNS Constants](https://learn.microsoft.com/en-us/windows/win32/dns/dns-constants)
* `Options`字面意思上理解是查询方式，我直接使用DNS_QUERY_STANDARD，具体也可以查询文档：[DNS Constants](https://learn.microsoft.com/en-us/windows/win32/dns/dns-constants)
* `pExtra`和`pReserved`直接给NULL就行
* `ppQueryResults`传入查询结果的指针，类型是PDNS_RECORD，这个需要传入变量值的引用。
* 返回值，DNS_STATUS类型，如果查询失败会返回Winerror.h中的相应错误码

## 使用
明白了使用方法，那就简单了。  
首先引入库：
```cpp
#include <windns.h>
#pragma comment(lib, "Ws2_32.lib")
#pragma comment(lib, "Dnsapi.lib")
```

我的TXT记录域名为test.iyoroy.cn，查询部分代码如下：

```cpp
PDNS_RECORD pDnsRecord;
DNS_STATUS QueryRet = DnsQuery(L"test.iyoroy.cn", DNS_TYPE_TEXT, DNS_QUERY_STANDARD, NULL, &pDnsRecord, NULL);
if (QueryRet) {
    MessageBox(GhWnd, L"DNS查询失败！\r\n将使用默认节点", L"Warning", MB_ICONERROR | MB_OK); 
}
std::wstring strQueryRes = *pDnsRecord->Data.TXT.pStringArray;//这个就是查询结果

```
成功实现功能

# 后记
TXT记录会自动过滤掉空格、换行，因此我选择记录base64编码，使用时再解码并使用stringstream拆分空格。Base64解码我借鉴了这篇文章：[C++进行base64编码和解码](https://blog.csdn.net/sky04/article/details/6881649)，以下是我用宽字节重写的解码函数


**展开代码**


```cpp
//Function:Base64解密
static const std::wstring base64_chars =
L"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
L"abcdefghijklmnopqrstuvwxyz"
L"0123456789+/";
static inline bool is_base64(wchar_t c) {
    return (isalnum(c) || (c == '+') || (c == '/'));
}

std::wstring base64_decode(std::wstring const& encoded_string) {
    int in_len = encoded_string.size();
    int i = 0;
    int j = 0;
    int in_ = 0;
    wchar_t char_array_4[4], char_array_3[3];
    std::wstring ret;

    while (in_len-- && (encoded_string[in_] != '=') && is_base64(encoded_string[in_])) {
        char_array_4[i++] = encoded_string[in_]; in_++;
        if (i == 4) {
            for (i = 0; i < 4; i++)
                char_array_4[i] = base64_chars.find(char_array_4[i]);

            char_array_3[0] = (char_array_4[0] << 2) + ((char_array_4[1] & 0x30) >> 4);
            char_array_3[1] = ((char_array_4[1] & 0xf) << 4) + ((char_array_4[2] & 0x3c) >> 2);
            char_array_3[2] = ((char_array_4[2] & 0x3) << 6) + char_array_4[3];

            for (i = 0; (i < 3); i++)
                ret += char_array_3[i];
            i = 0;
        }
    }

    if (i) {
        for (j = i; j < 4; j++)
            char_array_4[j] = 0;

        for (j = 0; j < 4; j++)
            char_array_4[j] = base64_chars.find(char_array_4[j]);

        char_array_3[0] = (char_array_4[0] << 2) + ((char_array_4[1] & 0x30) >> 4);
        char_array_3[1] = ((char_array_4[1] & 0xf) << 4) + ((char_array_4[2] & 0x3c) >> 2);
        char_array_3[2] = ((char_array_4[2] & 0x3) << 6) + char_array_4[3];

        for (j = 0; (j < i - 1); j++) ret += char_array_3[j];
    }

    return ret;
}
```

拆分：

```cpp
wstringstream wDnsRec(base64_decode(*pDnsRecord->Data.TXT.pStringArray));
wstring wNodes[16];

unsigned int nNodes = 0;
while (wDnsRec >> wNodes[nNodes])
    nNodes++;
```




之后再选择可用节点就行

****

参考文章：
* https://learn.microsoft.com/zh-cn/previous-versions/troubleshoot/windows/win32/use-dnsquery-resolve-host-names
* https://learn.microsoft.com/en-us/windows/win32/dns/dns-constants
* https://blog.csdn.net/sky04/article/details/6881649