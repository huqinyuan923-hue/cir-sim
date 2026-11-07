/**
 * esbuild 文本导入声明：.hack 程序文件（--loader:.hack=text）以字符串导入。
 */
declare module '*.hack' {
  const content: string;
  export default content;
}
