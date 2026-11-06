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
