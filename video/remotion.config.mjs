import { Config } from '@remotion/cli/config';
import fs from 'node:fs';

Config.setVideoImageFormat('jpeg');
Config.setConcurrency(4);
Config.setChromiumOpenGlRenderer('angle');
Config.setOverwriteOutput(true);

// 本机 Chrome 比 Remotion 的 chrome-headless-shell 下载快得多（后者约 150KB/s），
// 因此显式指定系统 Chrome。若该路径不存在则回退到 Remotion 自带下载。
const CHROME = 'C:\\Users\\UserX\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe';
if (fs.existsSync(CHROME)) {
  Config.setBrowserExecutable(CHROME);
}
