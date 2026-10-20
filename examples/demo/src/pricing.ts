/** 商品单价以分为单位，避免浮点运算带来的金额误差。 */
export interface CartItem {
  name: string;
  unitPrice: number;
  quantity: number;
}

export function calculateSubtotal(items: CartItem[]): number {
  return items.reduce((sum, item) => {
    return sum + item.unitPrice * item.quantity;
  }, 0);
}

/** 折扣按比例传入，例如 0.1 表示减免 10%。 */
export function calculateTotal(items: CartItem[], discount = 0): number {
  const subtotal = calculateSubtotal(items);
  const safeDiscount = Math.max(0, Math.min(discount, 1));

  return Math.round(subtotal * (1 - safeDiscount));
}
