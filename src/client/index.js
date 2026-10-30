window.__ModuleLoader__.load({
  id: 'dsh-maa-cli',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const CLIENT_STARTED_AT = Date.now()
    // Plans the user deleted from the confirmation panel stay hidden for the
    // rest of this client instance. The code itself still works server-side
    // until it expires (or is consumed), so the tool card drops its own
    // confirm button as well to avoid a second, competing entry point.
    const dismissedPlans = new Set()

    const ROGUELIKE_THEMES = [
      { value: 'Phantom', label: '傀影与猩红孤钻' },
      { value: 'Mizuki', label: '水月与深蓝之树' },
      { value: 'Sami', label: '探索者的银凇止境' },
      { value: 'Sarkaz', label: '萨卡兹的无终奇语' },
      { value: 'JieGarden', label: '岁的界园志异' },
      { value: 'BlackFlow', label: '黑流树海' },
    ]

    // MAA's 推荐开局 table (manual/introduction/integrated-strategy): each theme
    // lists the recommended difficulty, squads, roles and starting operator. The
    // panel starts from these values, tags them 【推荐】, and still lets the
    // player type anything MAA accepts.
    const ROGUELIKE_PRESETS = {
      Phantom: {
        difficulty: 2,
        squad: '指挥分队',
        squads: ['指挥分队', '突击战术分队'],
        roles: ['取长补短'],
        coreChar: '丰川祥子',
        chars: [{ name: '丰川祥子', useSupport: false }, { name: '棘刺', useSupport: false }],
      },
      Mizuki: {
        difficulty: 3,
        squad: '以人为本分队',
        squads: ['以人为本分队', '心胜于物分队'],
        roles: ['稳扎稳打'],
        coreChar: '维什戴尔',
        chars: [{ name: '维什戴尔', useSupport: true }],
      },
      Sami: {
        difficulty: 4,
        squad: '特训分队',
        squads: ['特训分队', '远程战术分队'],
        roles: ['稳扎稳打'],
        coreChar: '维什戴尔',
        chars: [{ name: '维什戴尔', useSupport: true }],
      },
      Sarkaz: {
        difficulty: 4,
        squad: '蓝图测绘分队',
        squads: ['蓝图测绘分队', '远程战术分队'],
        roles: ['稳扎稳打'],
        coreChar: '维什戴尔',
        chars: [{ name: '维什戴尔', useSupport: true }],
      },
      JieGarden: {
        difficulty: 3,
        squad: '指挥分队',
        squads: ['指挥分队', '远程战术分队'],
        roles: ['稳扎稳打'],
        coreChar: '维什戴尔',
        chars: [{ name: '维什戴尔', useSupport: true }],
      },
      // 黑流树海 is the newest theme; MAA's 推荐开局 lists no difficulty yet but
      // recommends 特勤分队 / 堡垒战术分队 with 稳扎稳打 / 坚不可摧 and 机械师.
      BlackFlow: {
        difficulty: 0,
        squad: '特勤分队',
        squads: ['特勤分队', '堡垒战术分队'],
        roles: ['稳扎稳打', '坚不可摧'],
        coreChar: '机械师',
        chars: [{ name: '机械师', useSupport: false }],
      },
    }

    // Every option the game offers as a 分队 name, copied from MAA's own squad
    // list so the panel never has to fall back to free text.
    const ROGUELIKE_SQUAD_NAMES = [
      '指挥分队', '突击战术分队', '堡垒战术分队', '远程战术分队', '破坏战术分队',
      '生活至上分队', '点刺成锭分队', '蓝图测绘分队', '以人为本分队', '心胜于物分队',
      '特训分队', '特勤分队', '高规格分队', '天师府分队', '司岁台分队', '魂灵护送分队',
      '本源研修分队', '博闻广记分队', '代理人分队', '地面突破分队', '高台突破分队',
      '地质调查分队', '多边贸易分队', '后勤分队', '花团锦簇分队', '集群分队',
      '开拓者分队', '科学主义分队', '矛头分队', '拟态学者分队', '棋行险着分队',
      '商贾分队', '岁影回音分队', '踏足遍历分队', '团结阵线分队', '文明开化分队',
      '物尽其用分队', '研究分队', '异想天开分队', '因地制宜分队', '永恒狩猎分队',
      '游客分队', '知学分队', '专业人士分队',
    ]
    const ROGUELIKE_ROLE_GROUPS = ['取长补短', '稳扎稳打', '坚不可摧']
    const ROGUELIKE_CHARS = ['维什戴尔', '丰川祥子', '棘刺', '机械师']
    const STARTS_COUNT_OPTIONS = [1, 2, 3, 4, 5, 10, 15, 20]
    const DIFFICULTY_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    const INVESTMENT_OPTIONS = [50, 100, 200, 500, 999]

    // Same numbers MaaCore accepts for RoguelikeTask.mode. `themes` limits a
    // mode to the theme that implements it so the panel cannot send a mode MAA
    // would ignore.
    const ROGUELIKE_MODES = [
      { value: 0, label: '刷分/奖励点数' },
      { value: 1, label: '刷源石锭' },
      { value: 4, label: '凹开局' },
      { value: 5, label: '刷坍缩范式', themes: ['Sami'] },
      { value: 6, label: '刷月度小队' },
      { value: 7, label: '刷深入调查' },
      { value: 10001, label: '快速过第一层', themes: ['Sarkaz'] },
      { value: 20001, label: '刷常乐节点', themes: ['JieGarden'] },
      { value: 30001, label: '刷襁褓动物', themes: ['BlackFlow'] },
    ]
    const ROGUELIKE_MODE_NOTES = {
      0: '刷等级/奖励点数：尽可能稳定地探索更多层数。',
      1: '刷源石锭：完成投资目标后自动退出；可在高级设置中决定是否购物、招募并进入第二层。',
      4: '凹开局：反复重开以获取期望奖励或让开局干员直升精二。',
      5: '刷坍缩范式：遇到不符合目标的坍缩范式后直接重开，仅适用于萨米主题。',
      6: '刷月度小队：尽可能稳定地探索更多层数，可在高级设置中自动切换小队。',
      7: '刷深入调查：尽可能稳定地探索更多层数，可在高级设置中自动切换调查。',
      10001: '快速通过第一层后结束，适合萨卡兹主题的快速循环。',
      20001: '第一层进入洞中寻找指定常乐节点，未找到时重开，仅适用于界园主题。',
      30001: '寻找并刷取指定襁褓动物，仅适用于黑流树海主题。',
    }

    function modesForTheme(theme) {
      return ROGUELIKE_MODES.filter(function (item) {
        return !item.themes || item.themes.indexOf(theme) >= 0
      })
    }

    const PLAY_TIME_TARGETS = [
      { value: 1, label: '令（掷地有声）' },
      { value: 2, label: '黍（种因得果）' },
      { value: 3, label: '年（三缺一）' },
    ]

    const CSS = [
      '.maa-plan-card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
      '.maa-plan-title{font-weight:600;margin-bottom:6px}',
      '.maa-plan-summary{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.maa-plan-actions{display:flex;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap}',
      '.maa-plan-button{height:34px;padding:0 14px;border:0;border-radius:8px;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-inverted);font:inherit;font-size:13px;cursor:pointer}',
      '.maa-plan-button:disabled{opacity:.55;cursor:default}',
      '.maa-stop-button{height:34px;padding:0 14px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:13px;cursor:pointer}',
      '.maa-stop-button:disabled{opacity:.55;cursor:default}',
      '.maa-plan-state{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.maa-note-input{flex:1 1 220px;min-width:0;height:30px;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.maa-note-input:disabled{opacity:.55;cursor:default}',
      '.maa-plan-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.maa-plan-result{width:100%;margin-top:10px;padding:10px 12px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.maa-confirm-dock{position:relative;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,100%);margin:0 auto;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l2));border-radius:var(--dsw-radius-panel,16px);padding:14px 16px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}',
      '.maa-confirm-dock-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding-right:84px}',
      '.maa-dock-actions{position:absolute;top:8px;right:8px;display:flex;gap:2px;z-index:1}',
      '.maa-dock-icon{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer}',
      '.maa-dock-icon:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2)}',
      '.maa-confirm-dock-copy{min-width:0;flex:1 1 260px}',
      '.maa-confirm-dock-title{font-size:13px;font-weight:600}',
      '.maa-confirm-dock-summary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.maa-rogue-panel{margin-top:10px;padding-top:10px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.maa-rogue-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px;font-size:12px;font-weight:600}',
      '.maa-rogue-hint{font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}',
      '.maa-rogue-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px 16px}',
      '.maa-rogue-field{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.maa-rogue-label{flex:0 0 auto;min-width:64px}',
      '.maa-rogue-control{flex:1 1 auto;min-width:0;height:28px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.maa-rogue-control:disabled{opacity:.55;cursor:default}',
      '.maa-rogue-toggle{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);min-width:0}',
      '.maa-rogue-toggle input{accent-color:var(--dsw-alias-brand-primary)}',
      '.maa-task-options{display:flex;flex-wrap:wrap;gap:6px 12px;padding:4px 0}',
      '.maa-task-option{display:inline-flex;align-items:center;gap:5px;color:var(--dsw-alias-label-primary);font-size:12px;white-space:nowrap}',
      '.maa-task-option input{accent-color:var(--dsw-alias-brand-primary)}',
      '.maa-task-field-block{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.maa-task-description{padding-left:72px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.maa-task-notes{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}',
      '.maa-task-note{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}',
      '.maa-task-note+.maa-task-note{margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.maa-rogue-advanced{margin-top:10px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l2)}',
      '.maa-rogue-summary{display:block;margin-bottom:8px;font-size:12px;font-weight:600;cursor:pointer;color:var(--dsw-alias-label-secondary)}',
      '.maa-rogue-summary::-webkit-details-marker{display:none}',
      '.maa-rogue-note{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
    ].join('')

    function installStyles() {
      if (document.getElementById('dsh-maa-cli-styles')) return
      const tag = document.createElement('style')
      tag.id = 'dsh-maa-cli-styles'
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    function resultText(block) {
      if (!block || !Array.isArray(block.content)) return ''
      return block.content.filter(item => item && item.type === 'text').map(item => item.text).join('\n')
    }

    function planArgs(block) {
      if (!block || !block.call || typeof block.call.argsRaw !== 'string') return null
      try {
        return JSON.parse(block.call.argsRaw)
      } catch (_) {
        return null
      }
    }

    function planSummary(block) {
      const args = planArgs(block)
      return args && typeof args.purpose === 'string' ? args.purpose : ''
    }

    // Roguelike steps carry their own settings; mirror the defaults the model
    // planned so the confirmation panel starts from MAA's actual parameters
    // instead of an empty form. Anything the plan leaves out falls back to the
    // 推荐开局 values MAA publishes for that theme.
    function roguelikeDefaults(block) {
      const args = planArgs(block)
      const steps = args && Array.isArray(args.steps) ? args.steps : []
      const step = steps.find(item => item && item.type === 'Roguelike')
      if (!step) return null
      return panelDefaults(step)
    }

    // Panel values for one roguelike step. Missing fields fall back to the
    // 推荐开局 values MAA publishes for that theme, so a plan that only names a
    // theme still opens a complete, sane form.
    function panelDefaults(step) {
      const value = step || {}
      const theme = ROGUELIKE_PRESETS[value.theme] ? value.theme : 'Phantom'
      const preset = ROGUELIKE_PRESETS[theme]
      const char = typeof value.coreChar === 'string' && value.coreChar ? value.coreChar : preset.coreChar
      const charPreset = preset.chars.find(function (item) { return item.name === char })
      return {
        theme: theme,
        mode: Number.isInteger(value.mode) ? value.mode : 0,
        // The panel always starts at 9999 (MAA's own default is effectively
        // unlimited); the field is a digit input so any count can be typed.
        startsCount: 9999,
        difficulty: Number.isInteger(value.difficulty) ? value.difficulty : preset.difficulty,
        squad: typeof value.squad === 'string' && value.squad ? value.squad : preset.squad,
        roles: typeof value.roles === 'string' && value.roles ? value.roles : preset.roles[0],
        coreChar: char,
        useSupport: typeof value.useSupport === 'boolean' ? value.useSupport : Boolean(charPreset && charPreset.useSupport),
        useNonFriendSupport: value.useNonFriendSupport === true,
        stopAtFinalBoss: value.stopAtFinalBoss === true,
        stopAtMaxLevel: value.stopAtMaxLevel === true,
        investmentEnabled: value.investmentEnabled !== false,
        investmentsCount: Number.isInteger(value.investmentsCount) ? value.investmentsCount : 999,
        stopWhenInvestmentFull: value.stopWhenInvestmentFull === true,
        investmentWithMoreScore: value.investmentWithMoreScore === true,
        startWithEliteTwo: value.startWithEliteTwo === true,
        onlyStartWithEliteTwo: value.onlyStartWithEliteTwo === true,
        monthlySquadAutoIterate: value.monthlySquadAutoIterate === true,
        deepExplorationAutoIterate: value.deepExplorationAutoIterate === true,
        findPlayTimeTarget: Number.isInteger(value.findPlayTimeTarget) ? value.findPlayTimeTarget : 1,
        useFoldartal: value.useFoldartal === true,
        checkCollapsalParadigms: value.checkCollapsalParadigms === true,
        refreshTraderWithDice: value.refreshTraderWithDice === true,
        // Free-form note for DSH itself; it never reaches MaaCore.
        note: '',
      }
    }

    // Values travel as key=value tokens on the local command plane; the server
    // validates them against the pending plan before the one-shot code is used.
    const CONFIRM_PARAM_KEYS = [
      'theme', 'mode', 'startsCount', 'difficulty', 'squad', 'roles', 'coreChar',
      'useSupport', 'useNonFriendSupport', 'stopAtFinalBoss', 'stopAtMaxLevel',
      'investmentEnabled', 'investmentsCount', 'stopWhenInvestmentFull', 'investmentWithMoreScore',
      'startWithEliteTwo', 'onlyStartWithEliteTwo', 'monthlySquadAutoIterate',
      'deepExplorationAutoIterate', 'findPlayTimeTarget',
      'useFoldartal', 'checkCollapsalParadigms', 'refreshTraderWithDice',
    ]

    // Which 高级功能 switches MAA actually honours for the current theme/mode;
    // the panel only renders these and confirmLine only sends these, so no
    // setting can be silently ignored on the MaaCore side.
    const ADVANCED_KEYS = [
      'useNonFriendSupport', 'stopAtFinalBoss', 'stopAtMaxLevel', 'investmentEnabled',
      'investmentsCount', 'stopWhenInvestmentFull', 'investmentWithMoreScore',
      'startWithEliteTwo', 'onlyStartWithEliteTwo', 'monthlySquadAutoIterate',
      'deepExplorationAutoIterate', 'findPlayTimeTarget', 'useFoldartal',
      'checkCollapsalParadigms', 'refreshTraderWithDice',
    ]

    const ADVANCED_LABELS = {
      useNonFriendSupport: '使用非好友助战',
      stopAtFinalBoss: '打到最终 Boss 停',
      stopAtMaxLevel: '等级刷满停',
      investmentEnabled: '投资源石锭',
      stopWhenInvestmentFull: '投资满停',
      investmentWithMoreScore: '投资后购物',
      startWithEliteTwo: '凹精二直升',
      onlyStartWithEliteTwo: '只凹精二直升',
      monthlySquadAutoIterate: '月度小队自动切换',
      deepExplorationAutoIterate: '深入调查自动切换',
      useFoldartal: '使用密文板',
      checkCollapsalParadigms: '检测坍缩范式',
      refreshTraderWithDice: '骰子刷新商店',
    }

    function allowedAdvancedKeys(value) {
      if (!value) return []
      const keys = []
      const take = function (key) { keys.push(key) }
      if (value.useSupport === true) take('useNonFriendSupport')
      // 仅除 Phantom 以外的主题才支持「打到最终 Boss 停」
      if (value.theme !== 'Phantom') take('stopAtFinalBoss')
      take('stopAtMaxLevel')
      take('investmentEnabled')
      if (value.investmentEnabled !== false) {
        take('investmentsCount')
        take('stopWhenInvestmentFull')
      }
      if (value.mode === 1) take('investmentWithMoreScore')
      if (value.mode === 4) {
        take('startWithEliteTwo')
        if (value.startWithEliteTwo === true) take('onlyStartWithEliteTwo')
      }
      if (value.mode === 6) take('monthlySquadAutoIterate')
      if (value.mode === 7) take('deepExplorationAutoIterate')
      if (value.mode === 20001) take('findPlayTimeTarget')
      if (value.theme === 'Sami') { take('useFoldartal'); take('checkCollapsalParadigms') }
      if (value.theme === 'Mizuki') take('refreshTraderWithDice')
      return keys
    }

    function fieldVisible(field, values) {
      const when = field && field.when
      if (!when) return true
      if (Object.prototype.hasOwnProperty.call(when, 'equals')) return values[when.key] === when.equals
      if (Object.prototype.hasOwnProperty.call(when, 'notEquals')) return values[when.key] !== when.notEquals
      return true
    }

    function encodedPanelValue(value) {
      if (Array.isArray(value)) return value.map(function (item) { return encodeURIComponent(String(item)) }).join(',')
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      return encodeURIComponent(String(value))
    }

    function confirmLine(code, params, fields) {
      const parts = ['/maa confirm', code]
      if (params) {
        if (Array.isArray(fields)) {
          fields.forEach(function (field) {
            if (!fieldVisible(field, params)) return
            const value = params[field.key]
            if (value === undefined || value === null) return
            parts.push(field.key + '=' + encodedPanelValue(value))
          })
        } else {
          const allowed = params.theme ? allowedAdvancedKeys(params) : []
          CONFIRM_PARAM_KEYS.forEach(function (key) {
            const value = params[key]
            if (value === undefined || value === null || value === '') return
            if (ADVANCED_KEYS.indexOf(key) >= 0 && params.theme && allowed.indexOf(key) < 0) return
            parts.push(key + '=' + encodedPanelValue(value))
          })
        }
        // The note is for DSH, not MaaCore: it travels URL-encoded so spaces and
        // punctuation survive the whitespace-separated key=value tokens.
        const note = typeof params.note === 'string' ? params.note.trim() : ''
        if (note) parts.push('note=' + encodeURIComponent(note))
      }
      return parts.join(' ')
    }

    function createPlanStore() {
      let value = null
      const listeners = new Set()
      const publish = function () { listeners.forEach(function (listener) { listener() }) }
      return {
        getSnapshot: function () { return value },
        subscribe: function (listener) { listeners.add(listener); return function () { listeners.delete(listener) } },
        set: function (next) {
          if (value && next && value.code === next.code) return
          value = next
          publish()
        },
        clear: function (code) {
          if (!value || (code && value.code !== code)) return
          value = null
          publish()
        },
        // The roguelike panel appears both in the tool card and in the composer
        // dock; both read and write the same parameters so the two never
        // disagree about what will be executed.
        setParams: function (code, params) {
          if (!value || !code || value.code !== code) return
          value = Object.assign({}, value, { params: params })
          publish()
        },
        complete: function (code, result) {
          if (!value || value.code !== code) return
          value = Object.assign({}, value, { result: String(result || '执行完成。') })
          publish()
        },
      }
    }

    const stores = new Map()
    function storeFor(sessionId) {
      const key = String(sessionId)
      let store = stores.get(key)
      if (!store) { store = createPlanStore(); stores.set(key, store) }
      return store
    }

    function useCommandButton(options) {
      const execute = options.execute
      const line = options.line
      const onSuccess = options.onSuccess
      const statePair = React.useState('ready')
      const state = statePair[0]
      const setState = statePair[1]
      const errorPair = React.useState('')
      const error = errorPair[0]
      const setError = errorPair[1]
      const resultPair = React.useState('')
      const result = resultPair[0]
      const setResult = resultPair[1]
      const stopRequested = React.useRef(false)
      const run = React.useCallback(function () {
        if (!line || state !== 'ready') return
        setState('running')
        setError('')
        setResult('')
        stopRequested.current = false
        Promise.resolve(execute(line)).then(function (outcome) {
          if (stopRequested.current) {
            setState('stopped')
            return
          }
          if (!outcome || outcome.kind !== 'success') {
            setState('ready')
            setError(outcome && outcome.text ? outcome.text : '本地命令执行失败。')
            return
          }
          setState('done')
          setResult(outcome.text || '执行完成。')
          if (onSuccess) onSuccess(outcome)
        }, function (reason) {
          if (stopRequested.current) {
            setState('stopped')
            return
          }
          setState('ready')
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [execute, line, state, onSuccess])
      const stop = React.useCallback(function () {
        if (state !== 'running') return
        stopRequested.current = true
        setState('stopping')
        setError('')
        Promise.resolve(execute('/maa stop')).then(function (outcome) {
          if (!outcome || outcome.kind !== 'success') {
            stopRequested.current = false
            setState('running')
            setError(outcome && outcome.text ? outcome.text : '停止任务失败。')
            return
          }
          setState('stopped')
          setResult(outcome.text || '任务已停止。')
          if (onSuccess) onSuccess(outcome)
        }, function (reason) {
          stopRequested.current = false
          setState('running')
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [execute, state, onSuccess])
      return { state, error, result, run, stop }
    }

    function ConfirmButton(props) {
      const action = useCommandButton({ execute: props.execute, line: props.line, onSuccess: props.onSuccess })
      return h(React.Fragment, null,
        h('button', {
          className: 'maa-plan-button', type: 'button',
          disabled: !props.line || action.state !== 'ready', onClick: action.run,
        }, action.state === 'running' ? '正在执行…'
          : action.state === 'stopping' ? '正在停止…'
          : action.state === 'stopped' ? '任务已停止'
          : action.state === 'done' ? '执行完成' : '确认并执行 MAA'),
        action.state === 'running' || action.state === 'stopping'
          ? h('button', {
              className: 'maa-stop-button', type: 'button',
              disabled: action.state === 'stopping', onClick: action.stop,
            }, action.state === 'stopping' ? '正在停止…' : '停止任务')
          : null,
        h('span', { className: 'maa-plan-state' },
          action.state === 'stopped' ? '不会自动继续剩余任务'
          : action.state === 'done' ? '本次确认没有调用模型' : '30 分钟内有效'),
        // The 备注 sits right of the validity hint: DSH reads it after the run
        // and decides what to do with it; there is no guarantee it is acted on.
        h('input', {
          className: 'maa-note-input', type: 'text', maxLength: 120,
          placeholder: '备注：想让 DSH 额外做的事（不保证执行）',
          title: '备注只交给 DSH 自行理解，不保证执行',
          value: typeof props.note === 'string' ? props.note : '',
          disabled: action.state !== 'ready',
          onChange: function (event) {
            if (props.onNoteChange) props.onNoteChange(event.target.value)
          },
        }),
        action.error ? h('div', { className: 'maa-plan-error' }, action.error) : null,
        action.result ? h('div', { className: 'maa-plan-result', role: 'status' }, action.result) : null)
    }

    // Generic MAA task settings. The host supplies the field definitions from
    // the same whitelist that validates `/maa confirm`, so the browser does not
    // maintain a second, drifting copy of task parameters.
    function TaskSettingsPanel(props) {
      const panel = props.panel
      const value = props.value || {}
      const disabled = props.disabled === true
      const update = function (patch) { props.onChange(Object.assign({}, value, patch)) }
      const fields = Array.isArray(panel.fields) ? panel.fields : []
      const wrapField = function (item, control) {
        return h('div', { className: 'maa-task-field-block', key: item.key },
          control,
          item.description ? h('div', { className: 'maa-task-description' }, item.description) : null)
      }

      const renderField = function (item) {
        if (!fieldVisible(item, value)) return null
        const current = value[item.key]
        if (item.kind === 'boolean') {
          return wrapField(item, h('label', { className: 'maa-rogue-toggle' },
            h('input', {
              type: 'checkbox', checked: current === true, disabled: disabled,
              onChange: function (event) { update({ [item.key]: event.target.checked }) },
            }),
            h('span', null, item.label)))
        }
        if (item.kind === 'multi') {
          const selected = Array.isArray(current) ? current : []
          return wrapField(item, h('div', { className: 'maa-rogue-field', style: { alignItems: 'flex-start' } },
            h('span', { className: 'maa-rogue-label' }, item.label),
            h('div', { className: 'maa-task-options' }, (item.options || []).map(function (entry) {
              const checked = selected.some(function (choice) { return String(choice) === String(entry.value) })
              return h('label', { className: 'maa-task-option', key: String(entry.value) },
                h('input', {
                  type: 'checkbox', checked: checked, disabled: disabled,
                  onChange: function (event) {
                    const next = selected.filter(function (choice) { return String(choice) !== String(entry.value) })
                    if (event.target.checked) next.push(entry.value)
                    update({ [item.key]: next })
                  },
                }), entry.label)
            }))))
        }
        if (item.kind === 'select') {
          return wrapField(item, h('label', { className: 'maa-rogue-field' },
            h('span', { className: 'maa-rogue-label' }, item.label),
            h('select', {
              className: 'maa-rogue-control', value: current === undefined ? '' : String(current), disabled: disabled,
              onChange: function (event) {
                const match = (item.options || []).find(function (entry) { return String(entry.value) === event.target.value })
                update({ [item.key]: match ? match.value : event.target.value })
              },
            }, (item.options || []).map(function (entry) {
              return h('option', { key: String(entry.value), value: String(entry.value) }, entry.label)
            }))))
        }
        const numeric = item.kind === 'integer' || item.kind === 'number'
        return wrapField(item, h('label', { className: 'maa-rogue-field' },
          h('span', { className: 'maa-rogue-label' }, item.label),
          h('input', {
            className: 'maa-rogue-control', type: numeric ? 'number' : 'text',
            min: numeric ? item.min : undefined, max: numeric ? item.max : undefined,
            step: numeric ? (item.step || 1) : undefined, maxLength: numeric ? undefined : item.maxLength,
            value: current === undefined || current === null ? '' : String(current),
            placeholder: item.placeholder || '', disabled: disabled,
            onChange: function (event) {
              const raw = event.target.value
              update({ [item.key]: numeric && raw !== '' ? Number(raw) : raw })
            },
          })))
      }

      const basic = fields.filter(function (item) { return !item.advanced }).map(renderField).filter(Boolean)
      const advanced = fields.filter(function (item) { return item.advanced }).map(renderField).filter(Boolean)
      const notes = (Array.isArray(panel.notes) ? panel.notes : []).filter(function (item) {
        return item && typeof item.text === 'string' && fieldVisible(item, value)
      })
      return h('div', { className: 'maa-rogue-panel' },
        h('div', { className: 'maa-rogue-head' },
          h('span', null, panel.title + '参数')),
        basic.length ? h('div', { className: 'maa-rogue-grid' }, basic) : h('div', { className: 'maa-rogue-note' }, '此项目没有可调参数。'),
        notes.length ? h('div', { className: 'maa-task-notes' }, notes.map(function (item, index) {
          return h('div', { className: 'maa-task-note', key: String(index) }, item.text)
        })) : null,
        advanced.length ? h('details', { className: 'maa-rogue-advanced' },
          h('summary', { className: 'maa-rogue-summary' }, '高级设置'),
          h('div', { className: 'maa-rogue-grid' }, advanced)) : null)
    }

    // Mirrors MAA's roguelike settings dialog. Theme, difficulty, squad, role
    // group and starting operator default to MAA's 推荐开局 values (tagged
    // 【推荐】, still editable) and the collapsed 高级功能 section exposes the
    // advanced switches MAA offers for RoguelikeTask.
    function RoguelikePanel(props) {
      const value = props.value
      const disabled = props.disabled === true
      const preset = ROGUELIKE_PRESETS[value.theme] || ROGUELIKE_PRESETS.Phantom
      const update = function (patch) { props.onChange(Object.assign({}, value, patch)) }
      // Every control is a picker: the panel never asks for a typed number or a
      // free-form squad / role group / operator name.
      const pick = function (label, key, options, coerce) {
        const raw = value[key]
        const text = raw === undefined || raw === null ? '' : String(raw)
        return h('label', { className: 'maa-rogue-field', key: key },
          h('span', { className: 'maa-rogue-label' }, label),
          h('select', {
            className: 'maa-rogue-control', value: text, disabled: disabled,
            onChange: function (event) {
              const next = event.target.value
              update({ [key]: coerce ? coerce(next) : next })
            },
          }, options.map(function (item) {
            return h('option', { key: String(item.value), value: String(item.value) }, item.label)
          })))
      }
      const toOptions = function (names, recommended) {
        return names.map(function (name) {
          return {
            value: name,
            label: recommended && recommended.indexOf(name) >= 0 ? name + '【推荐】' : name,
          }
        })
      }
      const withCurrent = function (options, current) {
        if (!current || options.some(function (item) { return item.value === current })) return options
        return [{ value: current, label: current }].concat(options)
      }
      const squadOptions = withCurrent(toOptions(
        preset.squads.concat(ROGUELIKE_SQUAD_NAMES.filter(function (name) { return preset.squads.indexOf(name) < 0 })),
        preset.squads), value.squad)
      const roleOptions = withCurrent(toOptions(
        preset.roles.concat(ROGUELIKE_ROLE_GROUPS.filter(function (name) { return preset.roles.indexOf(name) < 0 })),
        preset.roles), value.roles)
      const charNames = preset.chars.map(function (item) { return item.name })
      const charOptions = withCurrent(toOptions(
        charNames.concat(ROGUELIKE_CHARS.filter(function (name) { return charNames.indexOf(name) < 0 })),
        charNames), value.coreChar)
      const numberOptions = function (list, current) {
        const numbers = list.slice()
        if (Number.isInteger(current) && numbers.indexOf(current) < 0) numbers.push(current)
        return numbers.sort(function (a, b) { return a - b }).map(function (number) {
          return { value: number, label: String(number) }
        })
      }
      const boolOptions = [{ value: 'true', label: '是' }, { value: 'false', label: '否' }]
      const boolPick = function (label, key) {
        return pick(label, key, boolOptions, function (raw) { return raw === 'true' })
      }
      const numberPick = function (label, key, list) {
        return pick(label, key, numberOptions(list, value[key]), Number)
      }
      // 刷取次数 accepts hand-typed digits (MAA's own default is huge, so a fixed
      // picker cannot express it) while still rejecting every non-digit.
      const digitField = function (label, key) {
        const current = value[key]
        return h('label', { className: 'maa-rogue-field', key: key },
          h('span', { className: 'maa-rogue-label' }, label),
          h('input', {
            className: 'maa-rogue-control', type: 'text', inputMode: 'numeric', maxLength: 5,
            value: current === undefined || current === null ? '' : String(current),
            placeholder: '9999', disabled: disabled,
            onChange: function (event) {
              const digits = event.target.value.replace(/\D+/gu, '').slice(0, 5)
              update({ [key]: digits === '' ? '' : Number(digits) })
            },
            onBlur: function () {
              const raw = value[key]
              if (raw === '' || raw === undefined || raw === null || Number(raw) < 1) update({ [key]: 9999 })
            },
          }))
      }
      // Mode-scoped switches are reset when the mode changes so the 高级功能 list
      // never carries a setting MAA would ignore under the new mode.
      const modeScopedReset = {
        investmentWithMoreScore: false,
        startWithEliteTwo: false,
        onlyStartWithEliteTwo: false,
        monthlySquadAutoIterate: false,
        deepExplorationAutoIterate: false,
        findPlayTimeTarget: 1,
      }
      const changeMode = function (next) { update(Object.assign({ mode: next }, modeScopedReset)) }
      // Switching theme re-seeds the MAA recommendations for that theme and
      // clears the switches that only exist for the previous theme.
      const changeTheme = function (next) {
        const nextPreset = ROGUELIKE_PRESETS[next]
        const themeScopedReset = {
          useFoldartal: false,
          checkCollapsalParadigms: false,
          refreshTraderWithDice: false,
          stopAtFinalBoss: false,
        }
        if (!nextPreset) { update(Object.assign({ theme: next }, themeScopedReset)); return }
        const charPreset = nextPreset.chars.find(function (item) { return item.name === nextPreset.coreChar })
        const modeAllowed = modesForTheme(next).some(function (item) { return item.value === value.mode })
        update(Object.assign({
          theme: next,
          mode: modeAllowed ? value.mode : 0,
          difficulty: nextPreset.difficulty,
          squad: nextPreset.squad,
          roles: nextPreset.roles[0],
          coreChar: nextPreset.coreChar,
          useSupport: Boolean(charPreset && charPreset.useSupport),
        }, themeScopedReset))
      }
      // Only the switches MAA honours for this theme/mode are rendered at all.
      const allowed = allowedAdvancedKeys(value)
      const advancedNodes = allowed.map(function (key) {
        switch (key) {
          case 'investmentsCount': return numberPick('投资次数', key, INVESTMENT_OPTIONS)
          case 'findPlayTimeTarget': return h('label', { className: 'maa-rogue-field', key: key },
            h('span', { className: 'maa-rogue-label' }, '常乐节点'),
            h('select', {
              className: 'maa-rogue-control', value: String(value.findPlayTimeTarget), disabled: disabled,
              onChange: function (event) { update({ findPlayTimeTarget: Number(event.target.value) }) },
            }, PLAY_TIME_TARGETS.map(function (item) {
              return h('option', { key: item.value, value: String(item.value) }, item.label)
            })))
          default: return boolPick(ADVANCED_LABELS[key] || key, key)
        }
      })
      const roguelikeNotes = [ROGUELIKE_MODE_NOTES[value.mode]].filter(Boolean)
      if (value.theme === 'JieGarden') {
        roguelikeNotes.push('界园提示：解锁相关科技后，指挥分队在 N3 及以上难度会额外携带“时光之末”，可用于“一战一跳”存钱；未解锁该科技时不要选择 N3 及以上难度。')
      }
      return h('div', { className: 'maa-rogue-panel' },
        h('div', { className: 'maa-rogue-head' },
          h('span', null, '自动肉鸽参数'),
          h('span', { className: 'maa-rogue-hint' }, '默认取 MAA 推荐开局，可改；仍用同一个确认码执行')),
        h('div', { className: 'maa-rogue-grid' },
          h('label', { className: 'maa-rogue-field' },
            h('span', { className: 'maa-rogue-label' }, '主题'),
            h('select', {
              className: 'maa-rogue-control', value: value.theme, disabled: disabled,
              onChange: function (event) { changeTheme(event.target.value) },
            }, ROGUELIKE_THEMES.map(function (item) {
              return h('option', { key: item.value, value: item.value }, item.label)
            }))),
          h('label', { className: 'maa-rogue-field' },
            h('span', { className: 'maa-rogue-label' }, '模式'),
            h('select', {
              className: 'maa-rogue-control', value: String(value.mode), disabled: disabled,
              onChange: function (event) { changeMode(Number(event.target.value)) },
            }, modesForTheme(value.theme).map(function (item) {
              return h('option', { key: item.value, value: String(item.value) }, item.label)
            }))),
          numberPick('难度', 'difficulty', DIFFICULTY_OPTIONS),
          digitField('刷取次数', 'startsCount'),
          pick('分队', 'squad', squadOptions),
          pick('职业组', 'roles', roleOptions),
          pick('开局干员', 'coreChar', charOptions),
          boolPick('使用助战', 'useSupport')),
        roguelikeNotes.length ? h('div', { className: 'maa-task-notes' }, roguelikeNotes.map(function (text, index) {
          return h('div', { className: 'maa-task-note', key: String(index) }, text)
        })) : null,
        h('details', { className: 'maa-rogue-advanced' },
          h('summary', { className: 'maa-rogue-summary' }, '高级功能（MAA 高级设置）'),
          h('div', { className: 'maa-rogue-grid' }, advancedNodes),
          h('div', { className: 'maa-rogue-note' },
            '只显示当前主题/模式下 MAA 真正会用到的开关，改动后仍用同一个确认码执行；开局干员只用于第 1 顺位招募。')))
    }

    function MaaPlanCard(props) {
      const text = props.phase === 'result' ? resultText(props.block) : ''
      const match = text.match(/MAA-[A-F0-9]{6}/i)
      const code = match ? match[0].toUpperCase() : ''
      const summary = props.phase === 'preparing' ? '正在生成安全计划…' : planSummary(props.block)
      const defaults = props.phase === 'result' ? roguelikeDefaults(props.block) : null
      const plan = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
      const shared = plan && plan.code === code ? plan.params : null
      const effective = shared || defaults
      const dismissed = Boolean(code) && dismissedPlans.has(code)
      React.useEffect(function () {
        // Historical tool cards are replayed whenever DSH starts. Only a plan
        // produced while this client instance is alive may raise the composer
        // confirmation bar; otherwise an already-consumed old code could look
        // actionable after a restart.
        if (props.phase === 'result' && !props.block.isError && code
          && typeof props.block.time === 'number' && props.block.time >= CLIENT_STARTED_AT) {
          props.store.set({ code: code, summary: summary || 'MAA 操作计划', execute: props.execute, roguelike: defaults, params: null })
        }
      }, [props.phase, props.block, code, summary, props.store, props.execute])

      return h('div', { className: 'maa-plan-card', 'data-tool': 'maa_prepare_plan' },
        h('div', { className: 'maa-plan-title' }, 'MAA 操作计划'),
        h('div', { className: 'maa-plan-summary' }, summary || text || '正在准备…'),
        props.phase === 'result' && !props.block.isError && effective && !dismissed
          ? h(RoguelikePanel, {
              value: effective,
              disabled: false,
              onChange: function (next) { props.store.setParams(code, next) },
            })
          : null,
        props.phase === 'result' && !props.block.isError && !dismissed
          ? h('div', { className: 'maa-plan-actions' },
              h(ConfirmButton, {
                execute: props.execute,
                line: confirmLine(code, effective),
                note: effective && typeof effective.note === 'string' ? effective.note : '',
                onNoteChange: function (next) {
                  props.store.setParams(code, Object.assign({}, effective, { note: next }))
                },
                onSuccess: function () { props.store.clear(code) },
              }))
          : null,
      )
    }

    function MaaConfirmDock(props) {
      const plan = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
      const collapsedPair = React.useState(false)
      const collapsed = collapsedPair[0]
      const setCollapsed = collapsedPair[1]
      const code = plan ? plan.code : null
      // A fresh plan always opens expanded; collapsing is a per-plan choice.
      React.useEffect(function () { setCollapsed(false) }, [code])
      if (!plan) return null
      const effective = plan.params || plan.roguelike || (plan.taskPanel ? plan.taskPanel.values : null) || null
      const dismiss = function () {
        dismissedPlans.add(plan.code)
        props.store.clear(plan.code)
      }
      const actions = h('div', { className: 'maa-dock-actions' },
        h('button', {
          key: 'collapse', className: 'maa-dock-icon', type: 'button',
          title: collapsed ? '展开计划' : '最小化计划',
          'aria-label': collapsed ? '展开计划' : '最小化计划',
          onClick: function () { setCollapsed(!collapsed) },
        }, collapsed ? '+' : '\u2212'),
        h('button', {
          key: 'dismiss', className: 'maa-dock-icon', type: 'button',
          title: '删除当前计划（确认码仍有效，可用 /maa confirm 手动执行）',
          'aria-label': '删除当前计划',
          onClick: dismiss,
        }, '\u00d7'))
      if (plan.result) {
        return h('div', { className: 'maa-confirm-dock', role: 'status' },
          h('div', { className: 'maa-confirm-dock-head' },
            h('div', { className: 'maa-confirm-dock-copy' },
              h('div', { className: 'maa-confirm-dock-title' }, 'MAA 执行结果'),
              h('div', { className: 'maa-confirm-dock-summary' }, plan.result))),
          actions)
      }
      if (collapsed) {
        return h('div', { className: 'maa-confirm-dock', role: 'status' },
          h('div', { className: 'maa-confirm-dock-head' },
            h('div', { className: 'maa-confirm-dock-copy' },
              h('div', { className: 'maa-confirm-dock-title' }, 'MAA 计划等待你的确认'),
              h('div', { className: 'maa-confirm-dock-summary' }, plan.summary))),
          actions)
      }
      return h('div', { className: 'maa-confirm-dock', role: 'status' },
        h('div', { className: 'maa-confirm-dock-head' },
          h('div', { className: 'maa-confirm-dock-copy' },
            h('div', { className: 'maa-confirm-dock-title' }, 'MAA 计划等待你的确认'),
            h('div', { className: 'maa-confirm-dock-summary' }, plan.summary))),
        actions,
        plan.roguelike && effective
          ? h(RoguelikePanel, {
              value: effective,
              disabled: false,
              onChange: function (next) { props.store.setParams(plan.code, next) },
            })
          : null,
        plan.taskPanel && effective
          ? h(TaskSettingsPanel, {
              panel: plan.taskPanel,
              value: effective,
              disabled: false,
              onChange: function (next) { props.store.setParams(plan.code, next) },
            })
          : null,
        h('div', { className: 'maa-plan-actions' },
          h(ConfirmButton, {
            code: plan.code,
            execute: plan.execute,
            line: confirmLine(plan.code, effective, plan.taskPanel ? plan.taskPanel.fields : undefined),
            note: effective && typeof effective.note === 'string' ? effective.note : '',
            onNoteChange: function (next) {
              props.store.setParams(plan.code, Object.assign({}, effective, { note: next }))
            },
            onSuccess: function (outcome) { props.store.complete(plan.code, outcome.text) },
          })))
    }

    const inject = ['slots', 'remote', 'remote.commands']

    // Run one `/maa …` line on the local command plane (zero model calls) and
    // hand the settled result back to the caller.
    function commandRunner(ctx, sessionId) {
      return async function (line) {
        const response = await ctx.remote.commands.execute(sessionId, line, [])
        if (!response || response.ok !== true) {
          const failure = response && response.error
          throw new Error(failure && failure.message ? failure.message : '无法连接 DSH 本地命令服务。')
        }
        if (!response.value) return { kind: 'error', text: 'DSH 未识别 /maa 命令。' }
        return response.value.result
      }
    }

    // `/maa rouge …` only prepares a plan on the host. Its command result is a
    // plain notice, so this listener turns that notice into the composer
    // confirmation panel: it reads the pending plan back with the read-only
    // `/maa peek`, then raises the dock. Execution still needs the user's click
    // and runs through `/maa confirm`; no model turn is involved anywhere.
    function attachPlanNotices(ctx) {
      ctx.on('command/executed', function (sessionId, name, result) {
        if (name !== 'maa' || !result || result.kind === 'error' || typeof result.text !== 'string') return
        if (result.text.indexOf('MAA 计划待确认') < 0) return
        const match = result.text.match(/MAA-[A-F0-9]{6}/)
        if (!match) return
        const code = match[0].toUpperCase()
        const execute = commandRunner(ctx, sessionId)
        const store = storeFor(sessionId)
        Promise.resolve(execute('/maa peek ' + code)).then(function (peeked) {
          if (!peeked || typeof peeked.text !== 'string') return
          let payload = null
          try {
            payload = JSON.parse(peeked.text)
          } catch (error) {
            return
          }
          if (!payload || payload.code !== code) return
          const panel = payload.panel && typeof payload.panel === 'object' ? payload.panel : null
          if (!panel || typeof panel.type !== 'string' || !panel.values || typeof panel.values !== 'object') return
          const common = {
            code: code,
            summary: typeof payload.summary === 'string' && payload.summary ? payload.summary : 'MAA 计划',
            execute: execute,
            params: null,
          }
          if (panel.type === 'Roguelike') {
            const defaults = panelDefaults({ theme: panel.values.theme })
            store.set(Object.assign(common, { roguelike: Object.assign(defaults, panel.values) }))
          } else {
            store.set(Object.assign(common, { taskPanel: panel }))
          }
        }, function () {})
      })
    }

    function apply(ctx) {
      installStyles()
      attachPlanNotices(ctx)
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'maa_prepare_plan',
          inject: function (sessionId) {
            return {
              execute: commandRunner(ctx, sessionId),
              store: storeFor(sessionId),
            }
          },
        }, MaaPlanCard)
      })
      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock', id: 'maa-confirm', order: 5,
          inject: function (sessionId) { return { store: storeFor(sessionId) } },
        }, MaaConfirmDock)
      })
    }

    return { inject, apply }
  },
})
