const min = Number(process.argv[2]);
const max = Number(process.argv[3]);

if (Number.isNaN(min) || Number.isNaN(max)) {
  console.error("Usage: random-number <min> <max>");
  process.exit(1);
}

console.log(Math.floor(Math.random() * (max - min + 1)) + min);
