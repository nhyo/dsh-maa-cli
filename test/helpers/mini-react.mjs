// A deliberately small React stand-in for interaction tests. It implements the
// subset of React the DSH client uses (createElement, Fragment, useState,
// useRef, useCallback, useMemo, useEffect, useSyncExternalStore) with React's
// identity rules: a component instance lives at a tree position (type + key or
// index) and is UNMOUNTED — its hook state dropped and effects cleaned up — as
// soon as a render no longer produces it. That is exactly the property the
// minimize/expand tests need to observe.
export function createMiniReact() {
  const Fragment = Symbol.for('mini.fragment')
  let instances = new Map()
  let frame = null
  let effects = []
  let root = null
  let tree = null
  let scheduled = false
  let renders = 0
  const mounts = new Map()

  function createElement(type, props, ...children) {
    const flat = children.flat(Infinity)
    return { type, key: props?.key ?? null, props: { ...(props ?? {}), children: flat } }
  }

  function schedule() {
    if (!root || scheduled) return
    scheduled = true
    queueMicrotask(() => { scheduled = false; renderRoot() })
  }

  function slot() {
    const inst = frame.inst
    const index = frame.index++
    return { inst, index }
  }

  function useState(initial) {
    const { inst, index } = slot()
    if (!(index in inst.hooks)) inst.hooks[index] = typeof initial === 'function' ? initial() : initial
    const set = next => {
      if (!inst.alive) return
      const value = typeof next === 'function' ? next(inst.hooks[index]) : next
      if (Object.is(value, inst.hooks[index])) return
      inst.hooks[index] = value
      schedule()
    }
    return [inst.hooks[index], set]
  }

  function useRef(initial) {
    return useState(() => ({ current: initial }))[0]
  }

  function useEffect(effect, deps) {
    const { inst, index } = slot()
    const previous = inst.hooks[index]
    const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((value, at) => !Object.is(value, previous.deps[at]))
    if (!previous) inst.hooks[index] = { deps: undefined, cleanup: null }
    if (!changed) return
    effects.push(() => {
      if (!inst.alive) return
      const record = inst.hooks[index]
      if (typeof record.cleanup === 'function') record.cleanup()
      const cleanup = effect()
      inst.hooks[index] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null }
    })
  }

  function useSyncExternalStore(subscribe, getSnapshot) {
    const { inst, index } = slot()
    // Like React: a different `subscribe` function means a different store,
    // so drop the old subscription and attach to the new one.
    let record = inst.hooks[index]
    if (!record) {
      record = { subscribe: null, unsubscribe: null }
      inst.hooks[index] = record
      inst.cleanups.push(() => record.unsubscribe && record.unsubscribe())
    }
    if (record.subscribe !== subscribe) {
      if (record.unsubscribe) record.unsubscribe()
      record.subscribe = subscribe
      record.unsubscribe = subscribe(() => schedule())
    }
    return getSnapshot()
  }

  function resolve(element, path, seen) {
    if (element === null || element === undefined || element === false || element === true) return null
    if (typeof element === 'string' || typeof element === 'number') return String(element)
    if (Array.isArray(element)) return element.map((child, index) => resolve(child, `${path}[${child?.key ?? index}]`, seen))
    if (element.type === Fragment) return resolve(element.props.children, `${path}/#frag`, seen)
    if (typeof element.type === 'function') {
      const id = `${path}/${element.type.name || 'Anonymous'}${element.key !== null ? `#${element.key}` : ''}`
      let inst = instances.get(id)
      if (!inst) {
        inst = { hooks: [], cleanups: [], alive: true, name: element.type.name }
        instances.set(id, inst)
        mounts.set(inst.name, (mounts.get(inst.name) ?? 0) + 1)
      }
      seen.add(id)
      const saved = frame
      frame = { inst, index: 0 }
      let output
      try { output = element.type(element.props) } finally { frame = saved }
      return resolve(output, id, seen)
    }
    const { children, ...props } = element.props
    return { type: element.type, props, children: [].concat(resolve(children, `${path}/${element.type}`, seen) ?? []).flat(Infinity).filter(item => item !== null) }
  }

  function renderRoot() {
    if (!root) return
    renders += 1
    const seen = new Set()
    effects = []
    tree = resolve(root(), 'root', seen)
    for (const [id, inst] of instances) {
      if (seen.has(id)) continue
      inst.alive = false
      for (const hook of inst.hooks) if (hook && typeof hook.cleanup === 'function') hook.cleanup()
      for (const cleanup of inst.cleanups) cleanup()
      instances.delete(id)
    }
    const pending = effects
    effects = []
    for (const run of pending) run()
  }

  const React = {
    Fragment, createElement, useState, useRef, useEffect,
    useCallback: fn => fn,
    useMemo: fn => fn(),
    useSyncExternalStore,
  }

  return {
    React,
    mount(render) { root = render; renderRoot() },
    unmountAll() { root = () => null; renderRoot(); root = null },
    tree: () => tree,
    renders: () => renders,
    mountCount: name => mounts.get(name) ?? 0,
    alive: name => [...instances.values()].some(inst => inst.name === name),
  }
}

export function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  if (typeof node === 'string') return
  visit(node)
  walk(node.children, visit)
}

export function findAll(node, predicate) {
  const found = []
  walk(node, item => { if (predicate(item)) found.push(item) })
  return found
}

export function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

// Visible = not inside an element carrying the `hidden` attribute.
export function visibleText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(visibleText).join('')
  if (node.props?.hidden) return ''
  return visibleText(node.children)
}
