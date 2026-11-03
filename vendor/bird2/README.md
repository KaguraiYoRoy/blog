# BIRD2 TextMate Grammar

Vendored from [BIRD Chinese Community / BIRD-tm-language-grammar](https://github.com/bird-chinese-community/BIRD-tm-language-grammar).

- Upstream commit: `54662a020dec0d08e4e5652f6755ddaaa7abd8a0`
- Grammar version: `1.0.13-20260717`
- Original file: `grammars/bird2.tmLanguage.json`
- Author: BIRD Chinese Community (Alice39s)
- License: Mozilla Public License 2.0, reproduced in `LICENSE`

The grammar is kept locally so builds do not depend on GitHub availability.
The license is unmodified. Local change: exclude control-flow keywords from the
function-call rule so `if (...)` is highlighted as a conditional, not a function.
Update both files from a reviewed upstream commit, reapply this fix if needed,
and update this notice when upgrading.

`astro.config.mjs` registers the grammar with Expressive Code's Shiki highlighter.
Use `bird2` or its alias `bird` on Markdown fences:

````markdown
```bird2
protocol bgp upstream {
    local as 4242422024;
    neighbor fd18:3e15:61d0::1 as 4242423377;
}
```
````

Run `node --test scripts/bird-highlighting.test.mjs` to check integration and
representative BIRD2 syntax highlighting, including the full export-control
function in `scripts/fixtures/bird2-export.conf`.
