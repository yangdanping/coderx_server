#!/usr/bin/env python3
"""
Generate a PostgreSQL-compatible data import SQL file from a MySQL dump.

Usage:
  python3 database/postgresql/import_mysql_dump_to_pg.py \
    --dump "/path/to/mysql-dump.sql" \
    --output "database/postgresql/005_data_from_mysql_dump.sql"
"""

from __future__ import annotations

import argparse
import re
from pathlib import Path


TABLE_ORDER = [
    "user",
    "tag",
    "article",
    "collect",
    "avatar",
    "profile",
    "user_follow",
    "article_collect",
    "article_history",
    "article_like",
    "article_tag",
    "file",
    "comment",
    "comment_like",
    "report",
    "image_meta",
    "video_meta",
]

IDENTITY_TABLES = [
    "user",
    "tag",
    "article",
    "collect",
    "avatar",
    "profile",
    "article_history",
    "file",
    "comment",
    "report",
    "image_meta",
    "video_meta",
]

PG_TABLE_NAMES = {
    "user": 'public."user"',
    "tag": "public.tag",
    "article": "public.article",
    "collect": "public.collect",
    "avatar": "public.avatar",
    "profile": "public.profile",
    "user_follow": "public.user_follow",
    "article_collect": "public.article_collect",
    "article_history": "public.article_history",
    "article_like": "public.article_like",
    "article_tag": "public.article_tag",
    "file": "public.file",
    "comment": "public.comment",
    "comment_like": "public.comment_like",
    "report": "public.report",
    "image_meta": "public.image_meta",
    "video_meta": "public.video_meta",
}


class RawValue(str):
    """Marker for SQL raw values such as numbers and NULL-ish tokens."""


def quote_ident(identifier: str) -> str:
    return '"' + identifier.replace('"', '""') + '"'


def pg_table_regclass(table_name: str) -> str:
    if table_name == "user":
        return 'public."user"'
    return f"public.{table_name}"


def escape_sql_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "''") + "'"


def unescape_mysql_string(value: str) -> str:
    mapping = {
        "0": "",
        "b": "\b",
        "n": "\n",
        "r": "\r",
        "t": "\t",
        "Z": "\x1a",
        "\\": "\\",
        "'": "'",
        '"': '"',
    }
    result: list[str] = []
    i = 0
    length = len(value)
    while i < length:
        ch = value[i]
        if ch != "\\":
            result.append(ch)
            i += 1
            continue
        i += 1
        if i >= length:
            result.append("\\")
            break
        esc = value[i]
        result.append(mapping.get(esc, esc))
        i += 1
    return "".join(result)


def parse_mysql_create_table_columns(dump_text: str) -> dict[str, list[str]]:
    columns: dict[str, list[str]] = {}
    current_table: str | None = None
    current_columns: list[str] = []

    for line in dump_text.splitlines():
        if current_table is None:
            match = re.match(r"CREATE TABLE `([^`]+)` \($", line)
            if match:
                current_table = match.group(1)
                current_columns = []
            continue

        if line.startswith(") ENGINE="):
            columns[current_table] = current_columns[:]
            current_table = None
            current_columns = []
            continue

        column_match = re.match(r"\s*`([^`]+)`\s+", line)
        if column_match:
            current_columns.append(column_match.group(1))

    return columns


def parse_insert_statements(dump_text: str) -> dict[str, list[str]]:
    statements: dict[str, list[str]] = {}
    insert_re = re.compile(r"^INSERT INTO `([^`]+)` VALUES (.*);$")

    for line in dump_text.splitlines():
        match = insert_re.match(line)
        if not match:
            continue
        table_name = match.group(1)
        values_clause = match.group(2)
        statements.setdefault(table_name, []).append(values_clause)

    return statements


def parse_values_clause(values_clause: str) -> list[list[object]]:
    rows: list[list[object]] = []
    i = 0
    length = len(values_clause)

    def skip_separators() -> None:
        nonlocal i
        while i < length and values_clause[i] in " \t\r\n,":
            i += 1

    def skip_whitespace() -> None:
        nonlocal i
        while i < length and values_clause[i] in " \t\r\n":
            i += 1

    while True:
        skip_separators()
        if i >= length:
            break
        if values_clause[i] != "(":
            raise ValueError(f"Expected '(' at position {i}, got {values_clause[i]!r}")
        i += 1
        row: list[object] = []

        while True:
            skip_separators()
            if i >= length:
                raise ValueError("Unexpected end while parsing row")

            ch = values_clause[i]
            if ch == "'":
                i += 1
                buffer: list[str] = []
                while i < length:
                    current = values_clause[i]
                    if current == "\\":
                        if i + 1 >= length:
                            buffer.append("\\")
                            i += 1
                            continue
                        buffer.append("\\" + values_clause[i + 1])
                        i += 2
                        continue
                    if current == "'":
                        if i + 1 < length and values_clause[i + 1] == "'":
                            buffer.append("''")
                            i += 2
                            continue
                        i += 1
                        break
                    buffer.append(current)
                    i += 1
                row.append(unescape_mysql_string("".join(buffer)))
            else:
                start = i
                while i < length and values_clause[i] not in ",)":
                    i += 1
                token = values_clause[start:i].strip()
                if token.upper() == "NULL":
                    row.append(None)
                else:
                    row.append(RawValue(token))

            skip_whitespace()
            if i < length and values_clause[i] == ",":
                i += 1
                continue
            if i < length and values_clause[i] == ")":
                i += 1
                break
            if i >= length:
                raise ValueError("Unexpected end after row value")
            raise ValueError(f"Unexpected character {values_clause[i]!r} at position {i}")

        rows.append(row)
        skip_separators()

    return rows


def render_value(table_name: str, column_name: str, value: object) -> str:
    if value is None:
        return "NULL"

    if table_name == "image_meta" and column_name == "is_cover":
        raw_value = str(value)
        if raw_value == "1":
            return "TRUE"
        if raw_value == "0":
            return "FALSE"
        return "NULL"

    if isinstance(value, RawValue):
        return str(value)

    return escape_sql_string(str(value))


def chunked(rows: list[list[object]], chunk_size: int) -> list[list[list[object]]]:
    return [rows[index : index + chunk_size] for index in range(0, len(rows), chunk_size)]


def generate_data_sql(columns_by_table: dict[str, list[str]], values_by_table: dict[str, list[str]]) -> str:
    lines: list[str] = []
    lines.append("-- Generated from MySQL dump for PostgreSQL data import.")
    lines.append("-- This script preserves source IDs and should run after 001/002/003.")
    lines.append("BEGIN;")
    lines.append("SET TIME ZONE 'Asia/Shanghai';")
    lines.append("")

    for table_name in TABLE_ORDER:
        columns = columns_by_table.get(table_name)
        value_clauses = values_by_table.get(table_name, [])
        if not columns or not value_clauses:
            continue

        all_rows: list[list[object]] = []
        for clause in value_clauses:
            all_rows.extend(parse_values_clause(clause))

        target_table = PG_TABLE_NAMES[table_name]
        column_sql = ", ".join(quote_ident(column) for column in columns)

        lines.append(f"-- {table_name}: {len(all_rows)} row(s)")
        for batch in chunked(all_rows, 200):
            lines.append(f"INSERT INTO {target_table} ({column_sql}) VALUES")
            rendered_rows: list[str] = []
            for row in batch:
                rendered_values = [
                    render_value(table_name, column_name, value)
                    for column_name, value in zip(columns, row, strict=True)
                ]
                rendered_rows.append("  (" + ", ".join(rendered_values) + ")")
            lines.append(",\n".join(rendered_rows) + ";")
        lines.append("")

    lines.append("-- Reset sequences after explicit identity inserts.")
    for table_name in IDENTITY_TABLES:
        target_table = PG_TABLE_NAMES[table_name]
        regclass_name = pg_table_regclass(table_name)
        lines.append(
            "SELECT setval("
            f"pg_get_serial_sequence('{regclass_name}', 'id'), "
            f"COALESCE((SELECT MAX(id) FROM {target_table}), 1), "
            f"(SELECT MAX(id) IS NOT NULL FROM {target_table})"
            ");"
        )

    lines.append("")
    lines.append("COMMIT;")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate PostgreSQL data import SQL from a MySQL dump.")
    parser.add_argument("--dump", required=True, help="Path to the MySQL dump file")
    parser.add_argument("--output", required=True, help="Path to the generated PostgreSQL SQL file")
    args = parser.parse_args()

    dump_path = Path(args.dump)
    output_path = Path(args.output)

    dump_text = dump_path.read_text(encoding="utf-8")
    columns_by_table = parse_mysql_create_table_columns(dump_text)
    values_by_table = parse_insert_statements(dump_text)

    missing_columns = [table for table in TABLE_ORDER if table not in columns_by_table]
    missing_inserts = [table for table in TABLE_ORDER if table not in values_by_table]
    if missing_columns:
        raise SystemExit(f"Missing CREATE TABLE metadata for: {', '.join(missing_columns)}")
    if missing_inserts:
        print("Warning: no INSERT statements found for:", ", ".join(missing_inserts))

    sql_text = generate_data_sql(columns_by_table, values_by_table)
    output_path.write_text(sql_text, encoding="utf-8")
    print(f"Generated PostgreSQL data import SQL: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
