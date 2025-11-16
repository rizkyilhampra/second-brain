import { computePosition, flip, inline, shift } from "@floating-ui/dom"
import { normalizeRelativeURLs } from "../../util/path"
import { fetchCanonical } from "./util"

const p = new DOMParser()
let activeAnchor: HTMLAnchorElement | null = null
const MAX_POPOVER_DEPTH = 3
const activePopoverStack: HTMLElement[] = []
// Track hide timeouts per popover depth to prevent conflicts
const hideTimeouts = new Map<number, number>()
// Track which links have listeners attached to prevent duplicates
const popoverListenersAttached = new WeakMap<HTMLElement, Set<HTMLAnchorElement>>()

// Animation timing constants (must match popover.scss)
const ANIMATION_DELAY = 200 // ms - animation-delay in CSS
const ANIMATION_DURATION = 300 // ms - animation duration in CSS
const MOUSE_MOVEMENT_BUFFER = 200 // ms - extra time for user to move mouse
const TOTAL_HIDE_DELAY = ANIMATION_DELAY + ANIMATION_DURATION + MOUSE_MOVEMENT_BUFFER // 700ms

async function mouseEnterHandler(
  this: HTMLAnchorElement,
  { clientX, clientY }: { clientX: number; clientY: number },
) {
  const link = (activeAnchor = this)
  if (link.dataset.noPopover === "true") {
    return
  }

  // Cancel any pending hide timeouts for this depth and deeper
  const currentDepth = getCurrentPopoverDepth(link)
  cancelHideTimeoutsFromDepth(currentDepth)

  // Check if we've reached max depth
  if (currentDepth >= MAX_POPOVER_DEPTH) {
    return
  }

  async function setPosition(popoverElement: HTMLElement) {
    const { x, y } = await computePosition(link, popoverElement, {
      strategy: "fixed",
      middleware: [inline({ x: clientX, y: clientY }), shift(), flip()],
    })
    Object.assign(popoverElement.style, {
      transform: `translate(${x.toFixed()}px, ${y.toFixed()}px)`,
    })
  }

  function showPopover(popoverElement: HTMLElement, depth: number) {
    // Clear only popovers deeper than this one
    clearDeeperPopovers(depth)

    popoverElement.classList.add("active-popover")
    popoverElement.dataset.depth = depth.toString()
    // Set z-index based on depth (base 999 + depth * 10)
    popoverElement.style.zIndex = (999 + depth * 10).toString()

    setPosition(popoverElement as HTMLElement)

    // Add to active stack
    activePopoverStack[depth] = popoverElement

    if (hash !== "") {
      const targetAnchor = `#popover-internal-${hash.slice(1)}`
      const heading = popoverInner.querySelector(targetAnchor) as HTMLElement | null
      if (heading) {
        // leave ~12px of buffer when scrolling to a heading
        popoverInner.scroll({ top: heading.offsetTop - 12, behavior: "instant" })
      }
    }
  }

  const targetUrl = new URL(link.href)
  const hash = decodeURIComponent(targetUrl.hash)
  targetUrl.hash = ""
  targetUrl.search = ""
  const popoverId = `popover-${link.pathname}`
  const prevPopoverElement = document.getElementById(popoverId)

  // dont refetch if there's already a popover
  if (!!document.getElementById(popoverId)) {
    showPopover(prevPopoverElement as HTMLElement, currentDepth)
    // Re-attach listeners to ensure they work for the new depth
    attachPopoverListeners(prevPopoverElement as HTMLElement)
    return
  }

  const response = await fetchCanonical(targetUrl).catch((err) => {
    console.error(err)
  })

  if (!response) return
  const [contentType] = response.headers.get("Content-Type")!.split(";")
  const [contentTypeCategory, typeInfo] = contentType.split("/")

  const popoverElement = document.createElement("div")
  popoverElement.id = popoverId
  popoverElement.classList.add("popover")
  const popoverInner = document.createElement("div")
  popoverInner.classList.add("popover-inner")
  popoverInner.dataset.contentType = contentType ?? undefined
  popoverElement.appendChild(popoverInner)

  switch (contentTypeCategory) {
    case "image":
      const img = document.createElement("img")
      img.src = targetUrl.toString()
      img.alt = targetUrl.pathname

      popoverInner.appendChild(img)
      break
    case "application":
      switch (typeInfo) {
        case "pdf":
          const pdf = document.createElement("iframe")
          pdf.src = targetUrl.toString()
          popoverInner.appendChild(pdf)
          break
        default:
          break
      }
      break
    default:
      const contents = await response.text()
      const html = p.parseFromString(contents, "text/html")
      normalizeRelativeURLs(html, targetUrl)
      // prepend all IDs inside popovers to prevent duplicates
      html.querySelectorAll("[id]").forEach((el) => {
        const targetID = `popover-internal-${el.id}`
        el.id = targetID
      })
      const elts = [...html.getElementsByClassName("popover-hint")]
      if (elts.length === 0) return

      elts.forEach((elt) => popoverInner.appendChild(elt))
  }

  if (!!document.getElementById(popoverId)) {
    return
  }

  document.body.appendChild(popoverElement)
  if (activeAnchor !== this) {
    return
  }

  showPopover(popoverElement, currentDepth)

  // Attach event listeners to internal links within this popover
  attachPopoverListeners(popoverElement)

  // Add mouseenter handler to cancel any pending hide timeout for this popover
  popoverElement.addEventListener("mouseenter", function () {
    const depth = parseInt(popoverElement.dataset.depth || "0")
    cancelHideTimeoutsFromDepth(depth)
  })

  // Add mouseleave handler to this popover to clear deeper levels
  popoverElement.addEventListener("mouseleave", function (e: MouseEvent) {
    const relatedTarget = e.relatedTarget as Node | null
    const currentElementDepth = getPopoverDepth(popoverElement)

    // Check if we're leaving to a deeper popover or an internal link (don't clear in that case)
    if (relatedTarget && relatedTarget instanceof Element) {
      const leavingToPopover = relatedTarget.closest(".popover")
      const leavingToLink = relatedTarget.closest("a.internal")

      if (leavingToPopover) {
        const leavingToDepth = getPopoverDepth(leavingToPopover as HTMLElement)

        if (leavingToDepth > currentElementDepth) {
          // Moving to a deeper popover - don't clear anything
          return
        } else if (leavingToDepth === currentElementDepth) {
          // Moving laterally (same depth) - clear current and deeper, allow new one to show
          scheduleHideAtDepth(currentElementDepth)
          return
        } else {
          // Moving to shallower popover - clear current and deeper immediately
          clearDeeperPopovers(leavingToDepth + 1)
          return
        }
      }

      // If we're leaving to an internal link, delay clearing to allow new popover to spawn
      if (leavingToLink) {
        scheduleHideAtDepth(currentElementDepth)
        return
      }
    }

    // Not going to popover or link - clear this and deeper levels with delay
    // (delay allows user to move back if they overshoot)
    scheduleHideAtDepth(currentElementDepth)
  })
}

function getCurrentPopoverDepth(link: HTMLAnchorElement): number {
  // Check if the link is inside a popover
  let depth = 0
  let parent = link.parentElement
  while (parent) {
    if (parent.classList.contains("popover")) {
      const parentDepth = parseInt(parent.dataset.depth || "0")
      depth = parentDepth + 1
      break
    }
    parent = parent.parentElement
  }
  return depth
}

function clearDeeperPopovers(keepDepth: number) {
  // Remove popovers deeper than keepDepth from the stack
  // Note: keepDepth is the depth we're about to show, so clear everything >= keepDepth
  for (let i = keepDepth; i < activePopoverStack.length; i++) {
    const popover = activePopoverStack[i]
    if (popover) {
      popover.classList.remove("active-popover")
    }
  }
  // Trim the stack
  activePopoverStack.length = keepDepth
}

function clearActivePopover() {
  activeAnchor = null
  // Clear all popovers
  const allPopoverElements = document.querySelectorAll(".popover")
  allPopoverElements.forEach((popoverElement) => popoverElement.classList.remove("active-popover"))
  activePopoverStack.length = 0
  // Clear all pending timeouts
  hideTimeouts.forEach((timeoutId) => clearTimeout(timeoutId))
  hideTimeouts.clear()
}

function getPopoverDepth(popover: HTMLElement): number {
  // Safely parse depth with validation
  const depthStr = popover.dataset.depth
  if (!depthStr) return 0
  const depth = parseInt(depthStr, 10)
  return isNaN(depth) ? 0 : depth
}

function scheduleHideAtDepth(depth: number) {
  // Cancel any existing timeout for this depth
  const existingTimeout = hideTimeouts.get(depth)
  if (existingTimeout !== undefined) {
    clearTimeout(existingTimeout)
  }

  // Schedule new hide timeout
  const timeoutId = window.setTimeout(() => {
    clearDeeperPopovers(depth)
    hideTimeouts.delete(depth)
  }, TOTAL_HIDE_DELAY)

  hideTimeouts.set(depth, timeoutId)
}

function cancelHideTimeoutsFromDepth(depth: number) {
  // Cancel all timeouts at this depth and deeper
  hideTimeouts.forEach((timeoutId, timeoutDepth) => {
    if (timeoutDepth >= depth) {
      clearTimeout(timeoutId)
      hideTimeouts.delete(timeoutDepth)
    }
  })
}

function attachPopoverListeners(popoverElement: HTMLElement) {
  const links = [...popoverElement.querySelectorAll("a.internal")] as HTMLAnchorElement[]

  // Get or create the set of links that already have listeners
  let attachedLinks = popoverListenersAttached.get(popoverElement)
  if (!attachedLinks) {
    attachedLinks = new Set()
    popoverListenersAttached.set(popoverElement, attachedLinks)
  }

  for (const link of links) {
    // Skip if listeners already attached to this link
    if (attachedLinks.has(link)) {
      continue
    }

    // Only attach mouseenter - mouseleave is handled by the popover itself
    link.addEventListener("mouseenter", mouseEnterHandler)
    attachedLinks.add(link)
  }
}

function handleLinkLeave(this: HTMLAnchorElement, e: MouseEvent) {
  const relatedTarget = e.relatedTarget as Node | null

  // Don't clear if we're moving to a popover
  if (relatedTarget && relatedTarget instanceof Element) {
    const movingToPopover = relatedTarget.closest(".popover")
    if (movingToPopover) {
      return
    }
  }

  // Delay clearing to allow moving between link and popover
  // Use depth 0 (base level) for main page links
  scheduleHideAtDepth(0)
}

document.addEventListener("nav", () => {
  const links = [...document.querySelectorAll("a.internal")] as HTMLAnchorElement[]
  for (const link of links) {
    link.addEventListener("mouseenter", mouseEnterHandler)
    link.addEventListener("mouseleave", handleLinkLeave)
    window.addCleanup(() => {
      link.removeEventListener("mouseenter", mouseEnterHandler)
      link.removeEventListener("mouseleave", handleLinkLeave)
    })
  }

  // Clean up all popover elements and their listeners on navigation
  window.addCleanup(() => {
    // Remove all popover elements from DOM
    const allPopovers = document.querySelectorAll(".popover")
    allPopovers.forEach((popover) => {
      // Get tracked links for this popover
      const attachedLinks = popoverListenersAttached.get(popover as HTMLElement)
      if (attachedLinks) {
        // Remove listeners from all tracked links
        attachedLinks.forEach((link) => {
          link.removeEventListener("mouseenter", mouseEnterHandler)
        })
      }
      // Remove popover from DOM
      popover.remove()
    })

    // Clear tracking data
    activePopoverStack.length = 0
    activeAnchor = null

    // Clear all pending hide timeouts
    hideTimeouts.forEach((timeoutId) => clearTimeout(timeoutId))
    hideTimeouts.clear()
  })
})
