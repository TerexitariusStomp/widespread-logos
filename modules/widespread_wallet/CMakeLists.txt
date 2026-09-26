cmake_minimum_required(VERSION 3.20)
project(WidespreadWalletModule LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(DEFINED ENV{LOGOS_MODULE_BUILDER_ROOT})
    include($ENV{LOGOS_MODULE_BUILDER_ROOT}/cmake/LogosModule.cmake)
elseif(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/cmake/LogosModule.cmake")
    include(cmake/LogosModule.cmake)
else()
    message(FATAL_ERROR "LogosModule.cmake not found. Set LOGOS_MODULE_BUILDER_ROOT.")
endif()

# No C++ SOURCES: the builder-generated cdylib glue
# (generated_code/widespread_wallet_cdylib_glue.cpp, globbed by
# LogosModule.cmake) implements the plugin entry points; the wallet logic is
# the Rust staticlib staged by flake.nix's externalLibInputs and linked via
# EXTERNAL_LIBS (static archive — no runtime copy).
logos_module(
    NAME widespread_wallet
    EXTERNAL_LIBS
        widespread_wallet
)

if(MINGW OR WIN32)
    # These must sit AFTER logos_module() so they land at the END of the link
    # line — liblogos_protocol.a and the Qt archives (added by the macro)
    # carry the same libstdc++ undefineds, and GNU ld only looks backward.
    #
    # The Rust staticlib bundles C++ objects (witness-generator, rapidsnark)
    # that need the C++ runtime; rustls-platform-verifier's Schannel path
    # wants the certificate store API (crypt32); and the rapidsnark objects
    # were built against winpthreads — which nixpkgs' mingw sysroot lacks (it
    # builds against mcfgthread), so the flake's windows cross package ships
    # the static archive alongside libwidespread_wallet.a for us to link by
    # staged path.
    set(_wsp_win_link_libs
        crypt32
        gcc gcc_eh mingw32 moldname mingwex msvcrt
        kernel32 user32 advapi32 shell32 ws2_32 bcrypt ntdll userenv
        synchronization
    )
    if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwinpthread.a")
        list(PREPEND _wsp_win_link_libs
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwinpthread.a")
    endif()
    # nixpkgs' mingw toolchain DOES ship libstdc++.dll.a inside the gcc lib
    # output (gcc-*/x86_64-w64-mingw32/lib), and -lstdc++ resolves to it —
    # the vtables/typeinfo/system_error live in the import lib as __imp_*
    # entries. Linking the raw libstdc++-6.dll here would double-define the
    # .idata records against that import lib, so we rely on -lstdc++ (both
    # in the link libs and again inside the rescan group below). The flake
    # still stages the runtime DLL so the builder's win-dll-link postFixup
    # ships it next to the plugin.
    list(APPEND _wsp_win_link_libs stdc++)
    # Late-scan candidates: objects inside liblogos_protocol.a / the Qt
    # archives sit AFTER our libs on the link line, so their CRT references
    # (fstat64i32, _setjmp, SCard*) can never reach -lmsvcrt/-lwinscard placed
    # earlier. Resolve each candidate through the compiler's own search path
    # — the same mechanism ld uses for -l — so absent libs are skipped.
    set(_wsp_win_late "")
    foreach(_l winscard ucrtbase ucrt msvcrt-os msvcrt mingwex mingw32
              crypt32 advapi32 kernel32 user32 shell32 ws2_32 bcrypt ntdll
              userenv synchronization gcc gcc_eh moldname)
        execute_process(
            COMMAND ${CMAKE_CXX_COMPILER} -print-file-name=lib${_l}.a
            OUTPUT_VARIABLE _f OUTPUT_STRIP_TRAILING_WHITESPACE)
        if(_f MATCHES "^/" AND EXISTS "${_f}")
            list(APPEND _wsp_win_late "${_f}")
        endif()
    endforeach()
    # The dll.a import lib is what carries the vtables/typeinfo — resolve it
    # explicitly so it lands inside the rescan group, AFTER the protocol/Qt
    # archives that reference those symbols.
    execute_process(
        COMMAND ${CMAKE_CXX_COMPILER} -print-file-name=libstdc++.dll.a
        OUTPUT_VARIABLE _f OUTPUT_STRIP_TRAILING_WHITESPACE)
    if(_f MATCHES "^/" AND EXISTS "${_f}")
        list(APPEND _wsp_win_late "${_f}")
    else()
        list(APPEND _wsp_win_late stdc++)
    endif()
    # msys2-ABI compat: provides std::__get_once_call/__get_once_callable and
    # feeds the system_error ctor thunk emitted in wsp_refptr_stubs.o.
    target_sources(widespread_wallet_module_plugin PRIVATE
        src/wsp_msys2_compat.cpp)

    target_link_libraries(widespread_wallet_module_plugin PRIVATE
        ${_wsp_win_link_libs} ${_wsp_win_late})

    # ── .refptr stubs ────────────────────────────────────────────────────────
    # LLVM-emitted objects (our Rust staticlib, and objects inside
    # liblogos_protocol.a) reference .refptr.<sym> without defining it in a
    # linkonce section the way gcc does, and GNU ld does NOT synthesize
    # .refptr symbols (that is an LLD behavior). Emit a stub defining
    # .refptr.<sym> = &<sym>; for dllimport data <sym> resolves to the IAT
    # slot under --enable-auto-import, which is exactly the mechanism the
    # compiler's own linkonce section uses.
    # Tool discovery: the sandbox PATH may not expose the bintools, so ask the
    # driver first (-print-prog-name), then PATH, then glob the store — cover
    # every spelling the wrapped/unwrapped toolchains use.
    foreach(_tool nm as ar objcopy objdump)
        unset(_wsp_${_tool} CACHE)
        execute_process(
            COMMAND ${CMAKE_CXX_COMPILER} -print-prog-name=x86_64-w64-mingw32-${_tool}
            OUTPUT_VARIABLE _wsp_${_tool} OUTPUT_STRIP_TRAILING_WHITESPACE)
        if(NOT (_wsp_${_tool} MATCHES "^/" AND EXISTS "${_wsp_${_tool}}"))
            find_program(_wsp_${_tool} NAMES x86_64-w64-mingw32-${_tool})
        endif()
        if(NOT _wsp_${_tool})
            file(GLOB _wsp_tool_glob
                "/nix/store/*-binutils-*/bin/x86_64-w64-mingw32-${_tool}")
            if(_wsp_tool_glob)
                list(GET _wsp_tool_glob 0 _wsp_${_tool})
            endif()
        endif()
        message(STATUS "widespread_wallet: ${_tool} = ${_wsp_${_tool}}")
    endforeach()

    # ── defuse the msys2 ld -r COMDAT pathology ──────────────────────────────
    # The msys2-built witness/rapidsnark objects bundled into our staticlib
    # were produced by `ld -r` partial links that demoted template
    # instantiation definitions to LOCAL (scl 3) symbols while keeping
    # linkonce sections named <prefix>$<sym>. GNU ld keys PE COMDAT groups
    # on the section name: a member whose `$X` section only carries a LOCAL
    # copy of X (or no X at all) can still claim the group, so the real
    # global def in liblogos_protocol.a gets discarded and external refs
    # dangle. Globalizing every local is NOT safe — the same `*_local.o`
    # bundles deliberately carry duplicate fr.cpp code that would collide
    # with fr_generic.cpp.o's strong globals. Instead:
    #   G) a local symbol X sitting inside its own linkonce section
    #      `pfx$X` — the COMDAT leader — is promoted to global, so that
    #      whichever member's copy wins the group race exports a real
    #      definition (comdat dedup keeps exactly one copy; no dupes);
    #   b) a local symbol X referenced by siblings with NO global provider
    #      anywhere is globalized in the first member that has it;
    #   R) a linkonce section `pfx$Y` in a member that defines no Y at all
    #      (vacuous group stealer) is renamed to `pfx$wspdl<N>` so it can no
    #      longer claim the group.
    set(_wsp_wallet_a "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwidespread_wallet.a")
    if(_wsp_ar AND _wsp_objdump AND _wsp_objcopy AND _wsp_nm
            AND EXISTS "${_wsp_wallet_a}")
        set(_wsp_fix_script "${CMAKE_CURRENT_BINARY_DIR}/wsp_fix_archive.sh")
        file(WRITE "${_wsp_fix_script}" [=[
#!/usr/bin/env bash
set -u
AR="$1"; NM="$2"; OBJDUMP="$3"; OBJCOPY="$4"; A="$5"; shift 5
# remaining args: sibling inputs contributing refs/defs to the link
T=$(mktemp -d) || exit 0
cp "$A" "$T/all.a" || exit 0
cd "$T" || exit 0

# Single-pass COFF symbol table dump over the archive plus every sibling
# input (`In archive <file>:` delimits members; symbols print in the raw
# [n](sec N)(fl ..)(ty ..)(scl N) (nx N) <value> <name> form).
"$OBJDUMP" -t all.a "$@" > syms.txt 2>/dev/null || true
"$OBJDUMP" -h all.a > sech.txt 2>/dev/null || true

: > undef.txt; : > gdef.txt; : > loc.txt; : > gsec.txt; : > secname.txt
awk '
    /^In archive / {
        curarch = $3; sub(/:$/, "", curarch)
        isarch = (curarch == "all.a")
        next
    }
    /file format/ {
        mem = $1; sub(/:$/, "", mem)
        sub(/^.*\(/, "", mem); sub(/\)$/, "", mem)
        next
    }
    /^ *\[/ {
        line = $0; gsub(/[\[\]()]/, " ", line)
        n = split(line, f, /[ \t]+/)
        secnum = ""; scl = ""
        for (i = 1; i <= n; i++) {
            if (f[i] == "sec") secnum = f[i+1]
            else if (f[i] == "scl") scl = f[i+1]
        }
        name = f[n]
        if (secnum == "" || scl == "") next
        secnum += 0; scl += 0
        if (secnum == 0) {
            # external / weak-external undefined
            if (scl == 2 || scl == 105) print name > "undef.txt"
        } else if (secnum > 0) {
            if (scl == 3) {
                # scl 3 = static/local; names starting with "." are the
                # section symbols themselves (secnum -> secname map)
                if (name ~ /^\./ && isarch)
                    printf "%s\t%s\t%s\n", mem, secnum, name > "secname.txt"
                else if (isarch)
                    printf "%s\t%s\t%s\n", mem, secnum, name > "loc.txt"
            } else if (scl == 2 || scl == 105 || scl == 114) {
                print name > "gdef.txt"
                if (isarch) printf "%s\t%s\t%s\n", mem, secnum, name > "gsec.txt"
            }
        }
        next
    }' syms.txt
LC_ALL=C sort -u -o undef.txt undef.txt
LC_ALL=C sort -u -o gdef.txt gdef.txt

# per-member linkonce sections: mem<TAB>secname<TAB>suffix-sym
awk '
    function suffix(s, v) { v = s; sub(/^[^$]*\$/, "", v); return v }
    /^In archive / { next }
    /file format/ {
        mem = $1; sub(/:$/, "", mem)
        sub(/^.*\(/, "", mem); sub(/\)$/, "", mem)
        prevsec = ""
        next
    }
    /LINK_ONCE/ {
        # objdump -h wraps long flag lists onto a continuation line — the
        # section name then lives on the previous printed line
        if ($1 ~ /^[0-9]+$/ && $2 != "") s = $2; else s = prevsec
        if (s != "") printf "%s\t%s\t%s\n", mem, s, suffix(s)
        prevsec = ""
        next
    }
    $1 ~ /^[0-9]+$/ { prevsec = $2; next }
    { prevsec = "" }
' sech.txt > secsuf.txt

# plan: mem<TAB>G<TAB>sym      (globalize — sole provider of an undef'd sym)
#       mem<TAB>R<TAB>secname  (rename — vacuous/local-led linkonce section)
awk -F'\t' '
    FILENAME ~ /undef\.txt$/    { U[$0] = 1; next }
    FILENAME ~ /gdef\.txt$/     { G[$0] = 1; next }
    FILENAME ~ /loc\.txt$/      { LOCSEC[$1,$3] = $2; LOC[$1,$3] = 1; next }
    FILENAME ~ /gsec\.txt$/     { GSEC[$1,$3] = $2; next }
    FILENAME ~ /secname\.txt$/  { SNAME[$1,$2] = $3; next }
    FILENAME ~ /secsuf\.txt$/   { SECS[$1] = SECS[$1] $2 "\t" $3 "\n"; next }
    END {
        # every linkonce section P$Y: keep iff this member defines the
        # leader symbol Y inside S (legit provider); a LOCAL leader
        # is globalized so whichever copy wins still exports a real def;
        # a member with no Y def in S is a vacuous stealer -> rename S so
        # it can no longer claim the group.
        for (mem in SECS) {
            cnt = split(SECS[mem], rows, "\n")
            for (i = 1; i <= cnt; i++) {
                if (rows[i] == "") continue
                split(rows[i], c, "\t"); S = c[1]; Y = c[2]
                if ((mem, Y) in GSEC && SNAME[mem, GSEC[mem, Y]] == S) continue
                if ((mem, Y) in LOCSEC && SNAME[mem, LOCSEC[mem, Y]] == S) {
                    print mem "\tG\t" Y
                } else {
                    print mem "\tR\t" S
                }
            }
        }
        # undefined locals with no global provider anywhere: the first
        # member holding the symbol becomes the provider
        for (k in LOC) {
            split(k, m, SUBSEP); mem = m[1]; n = m[2]
            if ((n in U) && !(n in G) && !(n in done)) {
                done[n] = 1
                print mem "\tG\t" n
            }
        }
    }' undef.txt gdef.txt loc.txt gsec.txt secname.txt secsuf.txt | LC_ALL=C sort -u > plan.txt

cut -f1 plan.txt | LC_ALL=C sort -u > candmembers.txt
wc -l < plan.txt | sed 's/^/wsp_fix_archive: plan ops: /'
[ -s candmembers.txt ] || { echo "wsp_fix_archive: no candidates"; exit 0; }
"$AR" t all.a > names.txt

mkdir -p ex
cp all.a work.a
chmod u+w work.a
k=0
while IFS= read -r m; do
    b=$(basename "$m")
    (cd ex && "$AR" x ../all.a "$m") 2>/dev/null || true
    f="ex/$b"
    [ -f "$f" ] || continue
    args=()
    while IFS=$'\t' read -r _m op x _; do
        [ "$_m" = "$m" ] || continue
        if [ "$op" = "G" ]; then
            args+=(--globalize-symbol="$x")
        else
            p=${x%%\$*}
            args+=(--rename-section "$x=${p}\$wspdl${k}")
            k=$((k+1))
        fi
    done < plan.txt
    if [ ${#args[@]} -gt 0 ]; then
        "$OBJCOPY" "${args[@]}" "$f" || echo "wsp_fix_archive: objcopy failed on $m"
    fi
    # duplicate member names are byte-identical: patch once, then delete
    # every instance and re-add the fixed object the same number of times
    cnt=$(grep -Fxc -- "$m" names.txt); [ -n "$cnt" ] || cnt=1
    i=0; while [ "$i" -lt "$cnt" ]; do "$AR" d work.a "$m" 2>/dev/null; i=$((i+1)); done
    i=0; while [ "$i" -lt "$cnt" ]; do "$AR" q work.a "$f"; i=$((i+1)); done
done < candmembers.txt
"$AR" s work.a 2>/dev/null || true
rm -f "$A" && cp work.a "$A" && chmod u+w "$A"
echo "wsp_fix_archive: changed=1 renames=$k members=$(wc -l < candmembers.txt)"
]=])
        execute_process(
            COMMAND bash "${_wsp_fix_script}" "${_wsp_ar}" "${_wsp_nm}"
                    "${_wsp_objdump}" "${_wsp_objcopy}" "${_wsp_wallet_a}"
                    "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwinpthread.a"
                    "${LOGOS_PROTOCOL_ROOT}/lib/liblogos_protocol.a"
            OUTPUT_VARIABLE _wsp_fix_out ERROR_VARIABLE _wsp_fix_err
            RESULT_VARIABLE _wsp_fix_rc)
        message(STATUS "widespread_wallet: archive fix rc=${_wsp_fix_rc} ${_wsp_fix_out}")
    endif()
    # Emit a stub for every .refptr.<sym> name seen in the inputs whose <sym>
    # is globally resolvable (defined T/D/B/R/W or referenced U somewhere in
    # the same inputs — i.e. a library symbol or dll import). The linkonce
    # copies bundled inside archive members can be dropped by ld's linkonce
    # dedup when the keeper lands in an unpulled member — the failure mode
    # observed. A strong stub def supersedes linkonce copies and always
    # resolves: .refptr.<sym> = &<sym> (the IAT slot for dllimport data under
    # --enable-auto-import). Statics/anon locals (e.g. Rust 17h…E internals)
    # are skipped — their .refptr lives and dies inside their own TU.
    set(_wsp_refptr_syms "")
    set(_wsp_allsyms "")
    foreach(_lib
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwidespread_wallet.a"
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwinpthread.a"
            "${LOGOS_PROTOCOL_ROOT}/lib/liblogos_protocol.a")
        if(EXISTS "${_lib}" AND _wsp_nm)
            execute_process(COMMAND "${_wsp_nm}" "${_lib}"
                OUTPUT_VARIABLE _a ERROR_QUIET)
            string(APPEND _wsp_allsyms "${_a}\n")
        endif()
    endforeach()
    if(LOGOS_QT_HOST_ROOT)
        file(GLOB _wsp_host_libs "${LOGOS_QT_HOST_ROOT}/lib/*.a")
        foreach(_lib IN LISTS _wsp_host_libs)
            execute_process(COMMAND "${_wsp_nm}" "${_lib}"
                OUTPUT_VARIABLE _a ERROR_QUIET)
            string(APPEND _wsp_allsyms "${_a}\n")
        endforeach()
    endif()
    string(REGEX MATCHALL "[RrUuWw][ \t]+\\.refptr\\.[A-Za-z0-9_.$]+"
        _ms "${_wsp_allsyms}")
    foreach(_m IN LISTS _ms)
        string(REGEX REPLACE "^[RrUuWw][ \t]+\\.refptr\\." "" _s "${_m}")
        # <sym> must be resolvable at link scope: an external def (capital
        # class letters), an external undef (U/w — satisfied by a later lib or
        # the DLL), or an import entry (__imp_*/__nm_*). A lowercase ' X' line
        # is a LOCAL def — invisible to the stub TU — so it must not count.
        set(_wsp_found OFF)
        foreach(_p U T D B R W C V w u I i)
            string(FIND "${_wsp_allsyms}" " ${_p} ${_s}\n" _pos)
            if(NOT _pos EQUAL -1)
                set(_wsp_found ON)
                break()
            endif()
        endforeach()
        foreach(_p __imp_ __nm_)
            if(NOT _wsp_found)
                string(FIND "${_wsp_allsyms}" " ${_p}${_s}\n" _pos)
                if(NOT _pos EQUAL -1)
                    set(_wsp_found ON)
                endif()
            endif()
        endforeach()
        if(_wsp_found)
            list(APPEND _wsp_refptr_syms "${_s}")
        endif()
    endforeach()
    if(_wsp_as)
        list(REMOVE_DUPLICATES _wsp_refptr_syms)
        set(_wsp_refptr_asm "")
        foreach(_s IN LISTS _wsp_refptr_syms)
            # .linkonce discard marks the stub section as a real COMDAT
            # group so it dedups silently against the genuine .rdata$
            # .refptr.* sections in liblogos_protocol.a/Qt objects —
            # without it a strong .globl def meets the archive copy as a
            # multiple definition.
            string(APPEND _wsp_refptr_asm
                "\t.section .rdata$.refptr.${_s},\"dr\"\n\t.linkonce discard\n\t.globl .refptr.${_s}\n\t.align 8\n.refptr.${_s}:\n\t.quad ${_s}\n\n")
        endforeach()
        # msys2-built objects reference fstat64i32 WITHOUT the leading
        # underscore (asm-label spelling); the CRT import libs only carry
        # _fstat64i32/__imp__fstat64i32. Emit a tail-jump thunk.
        string(APPEND _wsp_refptr_asm
            "\t.text\n\t.globl fstat64i32\nfstat64i32:\n\tjmp _fstat64i32\n")
        # The gcc<=14-era non-inline std::system_error ctor is a plain U ref
        # in the msys2 objects — thunk it to the layout-identical shim in
        # wsp_msys2_compat.cpp.
        string(APPEND _wsp_refptr_asm
            "\t.globl _ZNSt12system_errorC1ESt10error_codePKc\n"
            "_ZNSt12system_errorC1ESt10error_codePKc:\n"
            "\tjmp _ZN15WspSysErrorShimC1ESt10error_codePKc\n")
        set(_wsp_refptr_s "${CMAKE_CURRENT_BINARY_DIR}/wsp_refptr_stubs.s")
        set(_wsp_refptr_o "${CMAKE_CURRENT_BINARY_DIR}/wsp_refptr_stubs.o")
        set(_wsp_refptr_a "${CMAKE_CURRENT_BINARY_DIR}/wsp_refptr_stubs.a")
        file(WRITE "${_wsp_refptr_s}" "${_wsp_refptr_asm}")
        execute_process(COMMAND "${_wsp_as}" "${_wsp_refptr_s}"
            -o "${_wsp_refptr_o}" RESULT_VARIABLE _as_rc)
        # Link the stubs as an ARCHIVE, not a bare object: the module macro
        # re-emits link libraries on the line a second time, and a bare .o
        # linked twice yields multiple-definition errors; an archive member
        # is only pulled on demand, so the second listing is a no-op — and
        # the extra position even helps late-arising .refptr undefs.
        if(_as_rc EQUAL 0 AND EXISTS "${_wsp_refptr_o}" AND _wsp_ar)
            execute_process(COMMAND "${_wsp_ar}" qc "${_wsp_refptr_a}"
                "${_wsp_refptr_o}" RESULT_VARIABLE _ar_rc)
            execute_process(COMMAND "${_wsp_ar}" s "${_wsp_refptr_a}")
        endif()
        if(EXISTS "${_wsp_refptr_a}")
            list(LENGTH _wsp_refptr_syms _n)
            message(STATUS "widespread_wallet: emitting ${_n} .refptr stubs")
            target_link_libraries(widespread_wallet_module_plugin PRIVATE
                "${_wsp_refptr_a}")
        else()
            message(WARNING "widespread_wallet: .refptr stub assembly failed (rc=${_as_rc})")
        endif()
    else()
        message(WARNING "widespread_wallet: no mingw 'as' found — .refptr stubs skipped")
    endif()
    # --enable-auto-import: objects compiled dllimport-style emit .refptr.*
    # refs that ld only resolves under auto-import.
    # --allow-multiple-definition: the msys2 objects carry dllimport refs
    # (__imp_X) whose import-thunk members define plain X as a strong
    # symbol — colliding with linkonce copies of the same inline function
    # inside liblogos_protocol.a (e.g. std::string::_M_erase). The defs are
    # semantically identical; first-definition-wins is the correct policy.
    target_link_options(widespread_wallet_module_plugin PRIVATE
        -static-libgcc -Wl,--enable-auto-import
        -Wl,--allow-multiple-definition)

    # Rescan group: liblogos_protocol.a has member-to-member references that
    # a single archive pass does not resolve (nlohmann instantiations defined
    # weakly in sibling members), protocol/Qt objects sit after our libs on
    # the line, and the .refptr stubs introduce fresh undefs (LogosAPI
    # vtables, staticMetaObject) whose definitions live in liblogos_qt_host.a
    # — scanned EARLIER on the line. Repeat every archive involved inside a
    # --start-group/--end-group so ld iterates to a fixed point.
    set(_wsp_win_group "")
    foreach(_g
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwidespread_wallet.a"
            "${CMAKE_CURRENT_SOURCE_DIR}/lib/libwinpthread.a"
            "${LOGOS_PROTOCOL_ROOT}/lib/liblogos_protocol.a"
            "${LOGOS_PROTOCOL_ROOT}/lib/liblogos_protocol.dll.a")
        if(EXISTS "${_g}")
            list(APPEND _wsp_win_group "${_g}")
        endif()
    endforeach()
    if(LOGOS_QT_HOST_ROOT)
        file(GLOB _wsp_host_group_libs "${LOGOS_QT_HOST_ROOT}/lib/*.a")
        list(APPEND _wsp_win_group ${_wsp_host_group_libs})
    endif()
    if(_wsp_win_group OR _wsp_win_late)
        target_link_libraries(widespread_wallet_module_plugin PRIVATE
            "-Wl,--start-group" ${_wsp_win_group} ${_wsp_win_late}
            "-Wl,--end-group")
    endif()
endif()
