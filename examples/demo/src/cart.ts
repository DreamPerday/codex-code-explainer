/** 购物车服务：维护商品并计算折扣后的应付金额。 */
import { calculateTotal, type CartItem } from './pricing.js';

export class CartService {
  private items: CartItem[] = [];

  /** 添加一项商品，返回当前商品种类数。 */
  addItem(item: CartItem): number {
    this.items.push(item);
    return this.items.length;
  }

  /** 结算时复用定价模块的折扣与舍入规则。 */
  checkout(discount = 0): number {
    return calculateTotal(this.items, discount);
  }
}
