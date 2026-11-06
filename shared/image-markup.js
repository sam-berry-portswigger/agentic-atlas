/** Convert viewport coordinates to original image pixels, independent of zoom.
 * @param {number} x @param {number} y
 * @param {{left:number,top:number,width:number,height:number}} rect
 * @param {number} width @param {number} height
 * @returns {[number,number]}
 */
export function imagePoint(x, y, rect, width, height) {
  return [
    Math.max(
      0,
      Math.min(width, ((x - rect.left) / Math.max(1, rect.width)) * width),
    ),
    Math.max(
      0,
      Math.min(height, ((y - rect.top) / Math.max(1, rect.height)) * height),
    ),
  ];
}
/** @param {[number,number]} start @param {[number,number]} end @param {number} length
 * @returns {Array<[number,number]>}
 */
export function arrowHead(start, end, length) {
  const angle = Math.atan2(end[1] - start[1], end[0] - start[0]);
  return [
    end,
    [
      end[0] - length * Math.cos(angle - Math.PI / 6),
      end[1] - length * Math.sin(angle - Math.PI / 6),
    ],
    [
      end[0] - length * Math.cos(angle + Math.PI / 6),
      end[1] - length * Math.sin(angle + Math.PI / 6),
    ],
  ];
}

/** Immutable snapshot history: a new edit after undo discards the redo branch.
 * @template T
 * @param {{past:T[][],present:T[],future:T[][]}} state
 * @param {{type:"commit",marks:T[]}|{type:"undo"|"redo"}} action
 * @returns {{past:T[][],present:T[],future:T[][]}}
 */
export function markupHistory(state, action) {
  if (action.type === "commit")
    return {
      past: [...state.past, state.present],
      present: action.marks,
      future: [],
    };
  if (action.type === "undo" && state.past.length)
    return {
      past: state.past.slice(0, -1),
      present: state.past.at(-1),
      future: [state.present, ...state.future],
    };
  if (action.type === "redo" && state.future.length)
    return {
      past: [...state.past, state.present],
      present: state.future[0],
      future: state.future.slice(1),
    };
  return state;
}

/** Trackpad pinch arrives as Ctrl+wheel; ordinary scrolling remains panning.
 * @param {number} scale
 * @param {{ctrlKey:boolean,metaKey?:boolean,deltaY:number,deltaMode:number}} event
 * @param {number} height
 * @returns {number|null}
 */
export function wheelImageScale(scale, event, height) {
  if ((!event.ctrlKey && !event.metaKey) || !Number.isFinite(event.deltaY))
    return null;
  const pixels =
    event.deltaY *
    (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? height : 1);
  return Math.max(
    0.02,
    Math.min(4, scale * Math.exp(Math.max(-4, Math.min(4, -pixels * 0.01)))),
  );
}
