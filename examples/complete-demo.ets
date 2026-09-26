interface Describable {
  description(): string;
}

class Motor {
  power: number;

  description(): string {
    return "Motor de " + numberToString(this.power) + " CV";
  }
}

class Car {
  motor: Motor;
  model: string;

  description(): string {
    return this.model + " con " + this.motor.description();
  }
}

function show(value: Describable): void {
  print(value.description());
}

let motor: Motor = new Motor(150);
let car: Car = new Car(motor, "Coupe");

show(motor);
show(car);
print("Potencia leída por composición: ", car.motor.power, " CV");
