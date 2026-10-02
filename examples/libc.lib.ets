@link("-lc")
@include("stdio.h")

@cpp_name("putchar")
export function putchar(c: i32): i32;

@cpp_name("getchar")
export function getchar(): i32;
