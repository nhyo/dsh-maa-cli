// Companion plugins ("辅助插件") that extend dsh-maa-cli.
//
// dsh-maa-cli stays dependency-free: anything heavy or outside MAA's own scope
// (network scraping, native OCR runtimes ...) lives in a separate package the
// user installs on demand with `/maa ext install <id>`. Each companion
// provides one cordis service; dsh-maa-cli looks it up per call with
// `ctx.get(service)` and checks `apiVersion` before using it.
//
// To add a companion: append an entry here, document its service contract in
// docs/extensions.md, and use `extensionService(ctx, id)` from host.js at the
// call site. Nothing else needs to change.

export const EXTENSIONS = Object.freeze([
  Object.freeze({
    id: 'coverocr',
    packageName: 'dsh-maa-coverocr',
    service: 'maaCoverocr',
    apiVersion: 1,
    title: 'B 站视频作业阵容识别',
    description: '读取 B 站作业视频的标题、简介、标签、UP 主评论，并用 MAA 自带的文字识别模型识别封面，找出视频用到的干员。',
    size: '约 300 MB（onnxruntime-node 自带多平台运行库）',
    // Development / mirrors: a pnpm spec used instead of the npm package name,
    // e.g. DSH_MAA_COVEROCR_SPEC=link:E:/DESK/dsh-maa-coverocr
    specEnv: 'DSH_MAA_COVEROCR_SPEC',
    // Dependencies whose install scripts are explicitly denied. pnpm 11 (the
    // host's package manager) fails an install on any unapproved build script;
    // onnxruntime-node's postinstall only downloads optional Linux CUDA
    // binaries, and the CPU runtime ships in the package. The denial is saved
    // to the profile's pnpm-workspace.yaml (allowBuilds), so later installs of
    // other plugins in the same profile don't trip over it either.
    deniedBuilds: Object.freeze(['onnxruntime-node']),
  }),
])

export function findExtension(id) {
  const key = String(id ?? '').trim().toLowerCase()
  return EXTENSIONS.find(entry => entry.id === key || entry.packageName === key) ?? null
}

export function extensionInstallArgs(entry, spec) {
  return ['add', spec, ...(entry.deniedBuilds ?? []).map(name => `--allow-build=!${name}`)]
}

export function extensionInstallSpec(entry, env = process.env) {
  const override = String(env[entry.specEnv] ?? '').trim()
  return override !== '' ? override : entry.packageName
}
