interface Named {
  name(): string;
}

class User {
  label: string;

  name(): string {
    return this.label;
  }
}

function show(value: Named): void {
  print(value.name());
}

let user: User = new User("Ada");
show(user);
