import { build } from 'esbuild';
import { cp, mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const staging = join(root, 'dist', 'agent-runtime');
const releases = join(root, 'dist', 'releases');
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, windowsHide: true, stdio: 'inherit' });
  child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error(`打包命令退出码 ${code}`)));
});

export async function buildAgent() {
  await mkdir(staging, { recursive: true });
  await build({ absWorkingDir: root, entryPoints: { 'runner/agent': 'apps/runner/src/agent-cli.ts', 'runner/worker': 'apps/runner/src/worker.ts', 'scripts/child': 'packages/scripts/src/child.ts' }, bundle: true, platform: 'node', target: 'node22', format: 'cjs', outdir: join(staging,'dist'), outExtension: {'.js':'.cjs'}, packages: 'external', logOverride: {'empty-import-meta':'silent'} });
  await mkdir(join(staging,'python','rpa_sdk'), {recursive:true});
  for (const name of ['__init__.py','__main__.py']) await cp(join(root,'python','rpa_sdk',name),join(staging,'python','rpa_sdk',name));
  await cp(join(root,'skills','personal-rpa'),join(staging,'skills','personal-rpa'),{recursive:true});
  await cp(join(root,'docs','Agent使用与分发.md'),join(staging,'README.md'));
  const versions = {...manifest.dependencies,...manifest.devDependencies};
  const runtime = {name:'personal-rpa-runtime',version:manifest.version,private:true,description:'供本地 Agent 开发和执行 Windows 自动化的 RPA 运行时',engines:manifest.engines,os:['win32'],bin:{'rpa-agent':'dist/runner/agent.cjs'},files:['dist','python','skills','README.md'],dependencies:Object.fromEntries(['playwright','xlsx','zod','esbuild','tsx'].map(name => [name,versions[name]]))};
  await writeFile(join(staging,'package.json'),JSON.stringify(runtime,null,2)+'\n');
  return staging;
}
async function packAgent() {
  await buildAgent(); await mkdir(releases,{recursive:true});
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('请通过 npm run pack:agent 打包，以使用当前 npm CLI');
  await run(process.execPath,[npm,'pack',staging,'--pack-destination',releases]);
  const plugin = join(root,'dist','personal-rpa-plugin');
  await mkdir(plugin,{recursive:true});
  await cp(join(root,'skills','personal-rpa'),join(plugin,'skills','personal-rpa'),{recursive:true});
  await writeFile(join(plugin,'plugin.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',name:'personal-rpa',version:manifest.version,description:'使用 rpa-agent 开发、检查和执行 Windows 本地自动化；需单独安装 personal-rpa-runtime',extensions:{'com.openai':{requires_local_executor:true}}},null,2)+'\n');
  const quote = value => `'${value.replaceAll("'","''")}'`;
  const zip = join(releases,`personal-rpa-plugin-${manifest.version}.zip`);
  if (dirname(zip) !== releases) throw new Error('插件输出路径必须位于分发目录');
  await unlink(zip).catch(error => {if(error.code!=='ENOENT')throw error;});
  const script = `Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory(${quote(plugin)},${quote(zip)})`;
  await run('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')]);
  console.log(`运行时与 Skill 插件包已输出：${releases}`);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--pack')) await packAgent();
  else console.log(`运行时构建完成：${await buildAgent()}`);
}
