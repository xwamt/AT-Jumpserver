import { describe, expect, it } from 'vitest';
import { isReadOnlySql } from '../../src/agent/SqlSafety';

describe('SqlSafety', () => {
  it.each([
    'select 1;',
    'SHOW DATABASES;',
    'describe users;',
    'desc users;',
    'EXPLAIN SELECT * FROM users;'
  ])('treats read-only SQL as safe: %s', (sql) => {
    expect(isReadOnlySql(sql)).toBe(true);
  });

  it.each([
    'insert into t values (1);',
    'update users set name = "x";',
    'delete from users;',
    'create table t(id int);',
    'alter table t add column name varchar(20);',
    'drop table t;',
    'truncate table t;',
    'call dangerous_proc();',
    'begin; select 1; commit;'
  ])('treats state-changing SQL as unsafe: %s', (sql) => {
    expect(isReadOnlySql(sql)).toBe(false);
  });
});
