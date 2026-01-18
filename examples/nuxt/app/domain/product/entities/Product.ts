/**
 * Product Entity
 * Aggregate root for the Product bounded context.
 */
export interface ProductProps {
  id: string;
  name: string;
  price: number;
  stock: number;
  createdAt: Date;
}

export class Product {
  readonly id: string;
  readonly name: string;
  private _price: number;
  private _stock: number;
  readonly createdAt: Date;

  private constructor(props: ProductProps) {
    this.id = props.id;
    this.name = props.name;
    this._price = props.price;
    this._stock = props.stock;
    this.createdAt = props.createdAt;
  }

  get price(): number {
    return this._price;
  }

  get stock(): number {
    return this._stock;
  }

  static create(props: { id: string; name: string; price: number; stock: number }): Product {
    if (props.price < 0) throw new Error('Price cannot be negative');
    if (props.stock < 0) throw new Error('Stock cannot be negative');

    return new Product({
      ...props,
      createdAt: new Date()
    });
  }

  static reconstitute(props: ProductProps): Product {
    return new Product(props);
  }

  updatePrice(newPrice: number): void {
    if (newPrice < 0) throw new Error('Price cannot be negative');
    this._price = newPrice;
  }

  addStock(quantity: number): void {
    if (quantity < 0) throw new Error('Quantity cannot be negative');
    this._stock += quantity;
  }

  removeStock(quantity: number): void {
    if (quantity > this._stock) throw new Error('Insufficient stock');
    this._stock -= quantity;
  }
}

