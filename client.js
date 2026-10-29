window.__ModuleLoader__.load({
  id: 'dsh-maa-cli',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const CLIENT_STARTED_AT = Date.now()

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
      '.maa-plan-error{font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.maa-confirm-dock{width:100%;box-sizing:border-box;border:1px solid color-mix(in srgb,var(--dsw-alias-brand-primary) 45%,var(--dsw-alias-border-l2));border-radius:12px;padding:12px 14px;background:color-mix(in srgb,var(--dsw-alias-brand-primary) 8%,var(--dsw-alias-bg-layer-1));color:var(--dsw-alias-label-primary)}',
      '.maa-confirm-dock-head{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.maa-confirm-dock-copy{min-width:0;flex:1 1 260px}',
      '.maa-confirm-dock-title{font-size:13px;font-weight:600}',
      '.maa-confirm-dock-summary{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
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

    function planSummary(block) {
      if (!block || !block.call || typeof block.call.argsRaw !== 'string') return ''
      try {
        const args = JSON.parse(block.call.argsRaw)
        return typeof args.purpose === 'string' ? args.purpose : ''
      } catch (_) {
        return ''
      }
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
      }
    }

    const stores = new Map()
    function storeFor(sessionId) {
      const key = String(sessionId)
      let store = stores.get(key)
      if (!store) { store = createPlanStore(); stores.set(key, store) }
      return store
    }

    function useCommandButton(execute, code, onSuccess) {
      const statePair = React.useState('ready')
      const state = statePair[0]
      const setState = statePair[1]
      const errorPair = React.useState('')
      const error = errorPair[0]
      const setError = errorPair[1]
      const stopRequested = React.useRef(false)
      const run = React.useCallback(function () {
        if (!code || state !== 'ready') return
        setState('running')
        setError('')
        stopRequested.current = false
        Promise.resolve(execute('/maa confirm ' + code)).then(function (outcome) {
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
          if (onSuccess) onSuccess()
        }, function (reason) {
          if (stopRequested.current) {
            setState('stopped')
            return
          }
          setState('ready')
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [execute, code, state, onSuccess])
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
          if (onSuccess) onSuccess()
        }, function (reason) {
          stopRequested.current = false
          setState('running')
          setError(reason instanceof Error ? reason.message : String(reason))
        })
      }, [execute, state, onSuccess])
      return { state, error, run, stop }
    }

    function ConfirmButton(props) {
      const action = useCommandButton(props.execute, props.code, props.onSuccess)
      return h(React.Fragment, null,
        h('button', {
          className: 'maa-plan-button', type: 'button',
          disabled: !props.code || action.state !== 'ready', onClick: action.run,
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
        action.error ? h('div', { className: 'maa-plan-error' }, action.error) : null)
    }

    function MaaPlanCard(props) {
      const text = props.phase === 'result' ? resultText(props.block) : ''
      const match = text.match(/MAA-[A-F0-9]{6}/i)
      const code = match ? match[0].toUpperCase() : ''
      const summary = props.phase === 'preparing' ? '正在生成安全计划…' : planSummary(props.block)
      React.useEffect(function () {
        // Historical tool cards are replayed whenever DSH starts. Only a plan
        // produced while this client instance is alive may raise the composer
        // confirmation bar; otherwise an already-consumed old code could look
        // actionable after a restart.
        if (props.phase === 'result' && !props.block.isError && code
          && typeof props.block.time === 'number' && props.block.time >= CLIENT_STARTED_AT) {
          props.store.set({ code: code, summary: summary || 'MAA 操作计划', execute: props.execute })
        }
      }, [props.phase, props.block, code, summary, props.store, props.execute])

      return h('div', { className: 'maa-plan-card', 'data-tool': 'maa_prepare_plan' },
        h('div', { className: 'maa-plan-title' }, 'MAA 操作计划'),
        h('div', { className: 'maa-plan-summary' }, summary || text || '正在准备…'),
        props.phase === 'result' && !props.block.isError
          ? h('div', { className: 'maa-plan-actions' },
              h(ConfirmButton, { code: code, execute: props.execute, onSuccess: function () { props.store.clear(code) } }))
          : null,
      )
    }

    function MaaConfirmDock(props) {
      const plan = React.useSyncExternalStore(props.store.subscribe, props.store.getSnapshot, props.store.getSnapshot)
      if (!plan) return null
      return h('div', { className: 'maa-confirm-dock', role: 'status' },
        h('div', { className: 'maa-confirm-dock-head' },
          h('div', { className: 'maa-confirm-dock-copy' },
            h('div', { className: 'maa-confirm-dock-title' }, 'MAA 计划等待你的确认'),
            h('div', { className: 'maa-confirm-dock-summary' }, plan.summary)),
          h('div', { className: 'maa-plan-actions', style: { marginTop: 0 } },
            h(ConfirmButton, { code: plan.code, execute: plan.execute, onSuccess: function () { props.store.clear(plan.code) } }))))
    }

    const inject = ['slots', 'remote', 'remote.commands']
    function apply(ctx) {
      installStyles()
      ctx.slots.inject('tool.call.toolview', function () {
        return ctx.slots.register({
          name: 'tool.call.toolview',
          key: 'maa_prepare_plan',
          inject: function (sessionId) {
            return {
              execute: async function (line) {
                const response = await ctx.remote.commands.execute(sessionId, line, [])
                if (!response || response.ok !== true) {
                  const failure = response && response.error
                  throw new Error(failure && failure.message ? failure.message : '无法连接 DSH 本地命令服务。')
                }
                if (!response.value) return { kind: 'error', text: 'DSH 未识别 /maa 命令。' }
                return response.value.result
              },
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
