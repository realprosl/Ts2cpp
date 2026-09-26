class Motor {
  power: number;

  label(): string {
    return "motor";
  }
}

class Car {
  motor: Motor;
  name: string;

  description(): string {
    return this.name + " con " + this.motor.label();
  }
}

let motor: Motor = new Motor(120);
let car: Car = new Car(motor, "Coupe");
print(car.description());
print(car.motor.power);
