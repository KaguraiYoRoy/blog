---
title: "Querying DNS Records Using WINAPI in C++"
published: 2025-03-20T09:33:00.000Z
updated: 2026-02-21T09:00:38.000Z
description: "Learn how to query DNS TXT records using C++ and the Windows WINAPI DnsQuery function. This guide includes code examples for retrieving and decoding Base64 encoded DNS data, handling multiple API endpoints via DNS."
image: ""
tags: ["C&C++", "Windows", "MSVC"]
category: "Develop"
categories: ["Develop"]
draft: false
lang: "en_US"
---

~~This article has been migrated from an old blog (a kind of cyber reincarnation)~~. Corrections are welcome if any errors are found.

# Timeline



- July 5, 2022: Published on the old blog, available on archive.org


- March 20, 2025: Migrated to the current blog


- Febuary 21, 2026: Added reminder for header and static library file links



# Background
Multiple access endpoints were configured for an API to handle service unavailability in certain regions where access might be blocked. Initially, I considered creating a file within the website to store node information, but this approach proved unfeasible because regions with connectivity issues couldn't retrieve information about other endpoints. Then, the idea emerged to use DNS resolution records - specifically, a TXT record - to store the relevant node data for querying.

# Implementation
## Research
After searching on Bing, I found that most existing articles use sockets to directly send query packets. However, these methods typically only retrieve A and CNAME records, which wasn't suitable for my needs. Finally, I focused on the `DnsQuery` function mentioned in MSDN and found a sample article: [Use DnsQuery to Resolve Host Names](https://learn.microsoft.com/en-us/previous-versions/troubleshoot/windows/win32/use-dnsquery-resolve-host-names).

## Function Analysis
According to the official documentation, the function requires the header `windns.h` and needs to link against the libraries `Ws2_32.lib` and `Dnsapi.lib`. The function parameters are as follows:

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

Parameter Explanation:
* `pszName` is the hostname to query.
* `wType` is the query type, such as A record, CNAME, TXT, etc. Specific constants are documented by MSDN: [DNS Constants](https://learn.microsoft.com/en-us/windows/win32/dns/dns-constants).
* `Options` literally means the query method. I used DNS_QUERY_STANDARD directly. Details can also be found in the documentation: [DNS Constants](https://learn.microsoft.com/en-us/windows/win32/dns/dns-constants).
* `pExtra` and `pReserved` can simply be set to `NULL`.
* `ppQueryResults`is a pointer to the query results, of type `PDNS_RECORD*`. This requires passing a reference to the variable's value.
* Return value: The `DNS_STATUS` type. If the query fails, it returns the corresponding error code from `Winerror.h`.

## Usage
Understanding the usage method made it straightforward.  
To avoid linker errors, make sure to include the following headers and libraries at the beginning:
```cpp
#include <windns.h>
#pragma comment(lib, "Ws2_32.lib")
#pragma comment(lib, "Dnsapi.lib")
```

My TXT record domain is `test.iyoroy.cn`. The query code is as follows:

```cpp
PDNS_RECORD pDnsRecord;
DNS_STATUS QueryRet = DnsQuery(L"test.iyoroy.cn", DNS_TYPE_TEXT, DNS_QUERY_STANDARD, NULL, &pDnsRecord, NULL);
if (QueryRet) {
    MessageBox(GhWnd, L"DNS query failed!\r\nWill use the default node.", L"Warning", MB_ICONERROR | MB_OK); 
}
std::wstring strQueryRes = *pDnsRecord->Data.TXT.pStringArray; // This is the query result.
```
Successfully implemented the functionality.

# Postscript
TXT records automatically filter out spaces and line breaks. Therefore, I chose to store Base64 encoded data in the record, decode it when used, and then split it using `stringstream`. For Base64 decoding, I adapted the code from this article: [Base64 Encoding and Decoding in C++](https://blog.csdn.net/sky04/article/details/6881649). Below is the rewritten decoding function using wide characters:



**Expand Code**


```cpp
//Function: Base64 Decryption
static const std::wstring base64_chars =
L"ABCDEFGHIJKLMNOPQRSTUVWXYZ"
L"abcdefghijklmnopqrstuvwxyz"
L"0123456789+/";
static inline bool is_base64(wchar_t c) {
    return (isalnum(c) || (c == L'+') || (c == L'/'));
}

std::wstring base64_decode(std::wstring const& encoded_string) {
    int in_len = encoded_string.size();
    int i = 0;
    int j = 0;
    int in_ = 0;
    wchar_t char_array_4[4], char_array_3[3];
    std::wstring ret;

    while (in_len-- && (encoded_string[in_] != L'=') && is_base64(encoded_string[in_])) {
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

Splitting the decoded string:

```cpp
wstringstream wDnsRec(base64_decode(*pDnsRecord->Data.TXT.pStringArray));
wstring wNodes[16];

unsigned int nNodes = 0;
while (wDnsRec >> wNodes[nNodes])
    nNodes++;
```




After that, selecting an available node becomes possible.

-----

Reference Articles:
* https://learn.microsoft.com/en-us/previous-versions/troubleshoot/windows/win32/use-dnsquery-resolve-host-names
* https://learn.microsoft.com/en-us/windows/win32/dns/dns-constants
* https://blog.csdn.net/sky04/article/details/6881649