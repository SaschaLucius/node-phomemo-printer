// Import required packages and modules.
import noble from "@abandonware/noble"; // For Bluetooth device scanning and connection.
import spinner from "cli-spinner"; // For displaying a spinner in the CLI.
import { Command } from "commander"; // For parsing command line arguments.
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "fs"; // For file I/O.
import * as path from "path"; // For path-related operations.
import { select, confirm } from "@inquirer/prompts"; // For interactive CLI prompts.
import Jimp from "jimp"; // For image processing.
import { PNG } from "pngjs"; // For PNG parsing and manipulation.

// Use your user‑defined dithering library.
import { dither, ALGORITHMS } from "./dithering.js";

const { Spinner } = spinner;

// The number of bytes per line that the printer expects.
// Adjust this value to match the specific printer output width.
const BYTES_PER_LINE = 70;
// The image width in pixels matching the printer characteristic.
// Each byte stands for 8 pixels, so we multiply.
const IMAGE_WIDTH = BYTES_PER_LINE * 8;

/**
 * Printer Resolution and Image Width Calculation:
 *
 * This printer is designed to work at a resolution of 300 pixels per inch (ppi).
 *
 * The constant BYTES_PER_LINE is set to 70, indicating the printer expects 70 bytes per line.
 * Since each byte represents 8 pixels, the maximum image width in pixels is calculated as:
 *
 *    IMAGE_WIDTH = BYTES_PER_LINE * 8
 *                = 70 * 8
 *                = 560 pixels
 *
 * At 300 ppi, the physical print width is:
 *
 *    Physical width (in inches) = IMAGE_WIDTH / 300
 *                               = 560 / 300 ≈ 1.87 inches
 *
 *    Physical width (in cm) = 1.87 * 2.54 ≈ 4.75 cm
 *
 * This means that with the current configuration, the printed image will have a width of approximately 4.75 cm.
 */

// Special keys for device selection menu.
const SCAN_AGAIN_SELECTION = "__scan_again__";
const QUIT_SELECTION = "__quit__";

// Object to hold discovered Bluetooth devices.
let discoveredDevices = {};
let selectedPeripheral = null; // <-- Added global variable for the peripheral

// -------------------------
// Command line interface setup
// -------------------------

// Set up command line options using Commander.
const program = new Command();
program
  .option("-f, --file <path>", "path for image to print", "./test.png")
  .option(
    "-s, --scale <size>",
    "percent scale at which the image should print (1-100)",
    100
  )
  .option(
    "--test",
    "Run in test mode and generate dithered images for all algorithms"
  );
program.parse(process.argv);
const { file, scale, test } = program.opts();

if (test) {
  // In test mode: create the 'test' folder if it doesn't exist.
  const testFolder = path.join(process.cwd(), "test");
  if (!existsSync(testFolder)) {
    mkdirSync(testFolder, { recursive: true });
  }

  // Loop through all algorithms and generate a test image for each.
  const algorithms = Object.keys(ALGORITHMS);
  for (const algo of algorithms) {
    const outputPath = path.join(testFolder, `${algo}.png`);
    console.log(`Generating test image using ${algo} algorithm...`);
    try {
      const ditheredPath = await makeTestDitheredImage(
        file,
        scale,
        algo,
        outputPath
      );
      console.log(`Saved: ${ditheredPath}`);
    } catch (err) {
      console.error(`Error generating ${algo}:`, err);
    }
  }
  process.exit(0);
}

// Create a selection prompt using keys from ALGORITHMS.
const algorithmChoice = await select({
  message: "Select dithering algorithm:",
  choices: Object.keys(ALGORITHMS).map((key) => ({
    // The key is used as both the display and value.
    value: key,
  })),
  default: "FLOYD_STEINBERG",
  pageSize: Object.keys(ALGORITHMS).length,
});

// Now that algorithmChoice is defined, pass it in:
const printableImgPath = await makeDitheredImage(file, scale, algorithmChoice);
const characteristic = await getDeviceCharacteristicMenu(printableImgPath);

// Prompt the user to select a density level.
// Soft, Medium, and Strong correspond to different density bytes.
const densityLevel = await select({
  message: "Select desired density level:",
  choices: [
    { name: "Lowest", value: 0x00 },
    { name: "Very Soft", value: 0x1a },
    { name: "Soft", value: 0x33 },
    { name: "Light", value: 0x4d },
    { name: "Default", value: 0x5e }, // at least it looks like this value is the default
    { name: "Medium Soft", value: 0x66 },
    { name: "Midtone", value: 0x80 },
    { name: "Medium", value: 0x99 },
    { name: "Medium Strong", value: 0xb3 },
    { name: "Strong", value: 0xcc },
    { name: "Very Strong", value: 0xe6 },
    { name: "Highest", value: 0xff },
  ],
  default: "Default",
  pageSize: 12,
});
if (densityLevel !== 0x5e) {
  await sendDensityControlPacket(characteristic, densityLevel);
}
// ---------------------------------------------------------

const data = await getPrintDataFromPort(printableImgPath);

// Write print data and wait until it's sent.
await new Promise((resolve, reject) => {
  characteristic.write(Buffer.from(data), true, (err) => {
    if (err) {
      return reject(err);
    }
    resolve();
  });
});

console.log("Print data sent.");

// Prompt the user to confirm that the image printed successfully.
const printedOk = await confirm({
  message: "Did the image print successfully?",
});

if (selectedPeripheral) {
  // Disconnect from the Bluetooth device.
  await selectedPeripheral.disconnectAsync();
}

if (printedOk) {
  console.log("Printing confirmed. Exiting.");
  process.exit(0);
} else {
  console.log("Printing not confirmed. Exiting anyway.");
  process.exit(1);
}

// -------------------------
// Helper Functions
// -------------------------

// Returns a promise that resolves after a given number of ms.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// This function scans for nearby Bluetooth devices and presents
// an interactive menu to select a valid Bluetooth printer.
// It keeps scanning until a writable device is found or the user quits.
async function getDeviceCharacteristicMenu(printableImgPath) {
  let scanDurationInMs = 5000;
  do {
    await scanDevices(scanDurationInMs);
    const choice = await selectDevice();

    if (choice === SCAN_AGAIN_SELECTION) {
      // If the user chooses to scan again, increase the scan duration.
      scanDurationInMs = 10000;
      scanDevices();
    } else if (choice == QUIT_SELECTION) {
      // Exit the process if the user opts to quit.
      process.exit();
    } else {
      // Retrieve the selected peripheral device.
      let peripheral = discoveredDevices[choice];
      // Attempt to get a characteristic that we can write to.
      const characteristic = await getWritableCharacteristic(peripheral);

      if (!characteristic) {
        // If unable to write to the chosen device, ask if the user wants to try again.
        const tryAgain = await promptTryAgain();
        if (tryAgain) {
          continue;
        } else {
          process.exit();
        }
      } else {
        // Return the writable characteristic if available.
        selectedPeripheral = peripheral; // Store peripheral globally
        return characteristic;
      }
    }
  } while (true);
}

// Scans for Bluetooth devices for a specified duration.
// Discovered devices with a valid localName are stored in discoveredDevices.
async function scanDevices(scanDurationInMs = 5000) {
  discoveredDevices = {};

  const spinner = new Spinner("scanning bluetooth devices.. %s");
  spinner.setSpinnerString("|/-\\");
  spinner.start();
  noble.on("discover", async (peripheral) => {
    const { localName } = peripheral.advertisement;
    if (localName === undefined || localName.trim().length === 0) {
      // Skip peripherals with invalid names.
      return;
    }
    discoveredDevices[localName] = peripheral;
  });
  noble.startScanningAsync();

  // Wait for the specified scanning duration.
  await delay(scanDurationInMs);

  // Stop scanning and clear the spinner.
  await noble.stopScanningAsync();
  spinner.stop(true);
}

// Presents an interactive CLI menu listing all discovered devices,
// along with options to scan again or quit.
async function selectDevice() {
  const choices = [];
  for (const key in discoveredDevices) {
    choices.push({
      value: key,
    });
  }
  choices.push({
    name: "- Scan again",
    value: SCAN_AGAIN_SELECTION,
  });

  choices.push({
    name: "- Quit",
    value: QUIT_SELECTION,
  });

  const prompt = {
    message: "Select your bluetooth printer",
    choices,
    pageSize: 12,
  };
  return select(prompt);
}

// Connects to a peripheral and discovers all its services and characteristics.
// Returns a characteristic that supports 'write' if available.
async function getWritableCharacteristic(peripheral) {
  await peripheral.connectAsync();
  const { characteristics } =
    await peripheral.discoverAllServicesAndCharacteristicsAsync();
  // Filter characteristics to find one that supports writing.
  const [characteristic] = characteristics.filter((characteristic) => {
    return characteristic.properties.includes("write");
  });
  return characteristic;
}

// Inform the user about an unsupported device and ask whether to try again.
async function promptTryAgain() {
  console.log("dang it doesn't look like we can print to this device 😕");
  return confirm({ message: "want to try again?" });
}

// This asynchronous function loads a dithered image from a file,
// converts it into a series of printer commands (following an ESC/POS‑style protocol),
// and returns an array of bytes that represent the complete print data.
async function getPrintDataFromPort(printableImgPath) {
  // Load the image using Jimp (a Node.js image library)
  const pic = await Jimp.read(printableImgPath);
  // 'remaining' holds the number of rows (vertical pixels) that need to be printed.
  let remaining = pic.bitmap.height;
  // 'printData' is our byte array that will contain the complete command stream.
  let printData = [];
  let index = 0;

  // ----- PRINTING HEADER -----
  // The header consists of commands that initialize the printer and set basic formatting.

  // ESC @ (27, 64): This command initializes the printer (resets it to default settings).
  printData[index++] = 27; // ESC (Escape, ASCII 27)
  printData[index++] = 64; // '@'

  // ESC a (27, 97): This command selects the justification (text alignment).
  // It is followed by one byte that indicates the desired alignment:
  // 0 = left, 1 = center, 2 = right.
  printData[index++] = 27; // ESC
  printData[index++] = 97; // 'a'
  printData[index++] = 0; // 0 means left-justified

  // These additional bytes (31, 17, 2, 4) are part of the printer’s initialization/header.
  // In many ESC/POS implementations, commands following the basic ones can be used to set specific modes
  // (such as print density, line spacing, or other manufacturer-specific settings).
  // Their exact meaning can vary by printer model.
  printData[index++] = 31; // (ASCII Unit Separator, sometimes used as a header delimiter)
  printData[index++] = 17; // (Device Control 1)
  printData[index++] = 2; // Parameter byte (could indicate a setting like print density/speed)
  printData[index++] = 4; // Another parameter byte
  // -----------------------------

  // 'line' keeps track of which row of the image we are processing.
  let line = 0;

  // The image is processed in blocks of up to 256 lines because of protocol limitations.
  while (remaining > 0) {
    let lines = remaining;
    if (lines > 256) {
      lines = 256; // Maximum block height: 256 lines.
    }

    // ----- PRINTING MARKER -----
    // Now we insert the command to print a raster bit image.
    // In Epson ESC/POS, the command for printing a raster image is GS v 0.
    // GS is ASCII 29, 'v' is ASCII 118, and '0' is ASCII 48.
    printData[index++] = 29; // GS (Group Separator, ASCII 29)
    printData[index++] = 118; // 'v'
    printData[index++] = 48; // '0'

    // Next comes the mode byte:
    // For Epson printers, the mode can control scaling (normal, double-width, double-height, or quadruple).
    // Here we use mode 0, which means "normal" (no scaling).
    printData[index++] = 0;

    // Then we specify the horizontal data: the number of bytes per line.
    // This value is sent as a 16-bit little-endian number.
    // 'BYTES_PER_LINE' is a constant (pre-calculated as image width/8) that tells how many bytes represent one line.
    printData[index++] = BYTES_PER_LINE; // Lower byte of the horizontal byte count
    printData[index++] = 0; // Upper byte (assuming BYTES_PER_LINE is less than 256)

    // Next, we specify the block height (the number of lines in this block) minus one.
    // This value is also given as a 16-bit little-endian number.
    printData[index++] = lines - 1; // Lower byte: (block height - 1)
    printData[index++] = 0; // Upper byte
    // -----------------------------

    // Deduct the lines we are about to process.
    remaining -= lines;

    // For each line in the current block:
    while (lines > 0) {
      // For each horizontal block of 8 pixels (one byte), repeat:
      for (let x = 0; x < BYTES_PER_LINE; x++) {
        let byte = 0; // This byte will represent 8 pixels (1 bit per pixel)
        for (let bit = 0; bit < 8; bit++) {
          // Calculate the x coordinate: each byte represents 8 pixels.
          const pixelX = x * 8 + bit;
          const pixelY = line;
          // Get the color of the pixel at (pixelX, pixelY) and convert it into an RGBA object.
          const rgba = Jimp.intToRGBA(pic.getPixelColor(pixelX, pixelY));
          // In our dithered image, a pixel is “on” (black) if its red component is 0
          // and it is not transparent (alpha ≠ 0). If so, we set the corresponding bit.
          if (rgba.r === 0 && rgba.a !== 0) {
            byte |= 1 << (7 - bit);
          }
        }
        // Special handling: if the byte equals 0x0A (line feed), replace it with 0x14.
        // This avoids conflicts with actual line-feed commands in the protocol.
        if (byte === 0x0a) {
          byte = 0x14;
        }
        // Append this byte (representing 8 pixels) to our printData array.
        printData[index++] = byte;
      }
      // One line of image data is done; update counters.
      lines--; // One less line to process in the current block.
      line++; // Move to the next line in the overall image.
    }
  }

  // ----- PRINTING FOOTER -----
  // After sending all image data, we add footer commands.
  // These commands typically feed extra blank lines to push the printed image fully out of the printer,
  // and may also signal the end of the print job.

  // ESC d n (27, 100, n): This command prints the data in the buffer and feeds paper n lines.
  // Here, we feed 2 lines, twice.
  printData[index++] = 27; // ESC
  printData[index++] = 100; // 'd'
  printData[index++] = 2; // Feed 2 lines

  printData[index++] = 27; // ESC
  printData[index++] = 100; // 'd'
  printData[index++] = 2; // Feed another 2 lines

  // These additional footer bytes (31, 17, followed by 8, 14, 7, 9) are likely proprietary or
  // manufacturer-specific commands that signal the end of the print job and ensure that the paper is
  // properly positioned for cutting or finishing.
  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 8;

  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 14;

  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 7;

  printData[index++] = 31;
  printData[index++] = 17;
  printData[index++] = 9;
  // -----------------------------

  // Finally, return the complete array of commands and image data.
  return printData;
}

// This function processes the image file to match the printer's requirements.
// It performs several steps: resizing, compositing with a transparent background,
// and finally dithering.
async function makeDitheredImage(imgPath, scale, algorithmChoice) {
  let originalFileName = path.basename(imgPath);
  if (!originalFileName) {
    throw new Error("Invalid file name");
  }
  let pic = await Jimp.read(imgPath);
  const scalePercentage = Math.max(scale / 100.0, 0.01);
  const scaledWidth = Math.floor(scalePercentage * IMAGE_WIDTH);

  // Resize the image based on scale percentage.
  const resizedImgPath = `${imgPath}--resized.png`;
  pic = pic.resize(scaledWidth, Jimp.AUTO);

  // Read the transparent background image to fill in space.
  let transparentBackground = await Jimp.read("./transparent-square.png");
  transparentBackground = transparentBackground.resize(
    IMAGE_WIDTH,
    pic.bitmap.height
  );
  // Calculate offset to composite the image against the background.
  const x = IMAGE_WIDTH - pic.bitmap.width;
  const composedPic = transparentBackground.composite(pic, x, 0);

  // Write the composite image to file.
  await composedPic.writeAsync(resizedImgPath);

  // Convert the composed image to a dithered black & white image.
  // TODO: Consider swapping the dithering library for improved quality.
  return convertToDithered(resizedImgPath, algorithmChoice);
}

// This function performs image dithering using the Floyd-Steinberg algorithm.
// It converts a resized image into a dithered image suitable for the printer.
async function convertToDithered(resizedImgPath, algorithmChoice) {
  const ditheredImgPath = `${resizedImgPath}--dithered.png`;
  return new Promise((resolve, reject) => {
    createReadStream(resizedImgPath)
      .pipe(new PNG())
      .on("parsed", function () {
        // 'this' is the PNG image object with width, height, and data properties.
        // Apply the selected dithering algorithm using your library.
        // Lookup the algorithm from ALGORITHMS using the algorithmChoice key.
        dither(this, ALGORITHMS[algorithmChoice]);
        // Pack the modified image data and pipe it to a write stream.
        this.pack()
          .pipe(createWriteStream(ditheredImgPath))
          .on("finish", () => resolve(ditheredImgPath))
          .on("error", reject);
      })
      .on("error", reject);
  });
}

// Helper function for test mode: Process the image using the selected dithering algorithm and output to a specific path.
async function makeTestDitheredImage(
  imgPath,
  scale,
  algorithmChoice,
  outputPath
) {
  let originalFileName = path.basename(imgPath);
  if (!originalFileName) {
    throw new Error("Invalid file name");
  }
  let pic = await Jimp.read(imgPath);
  const scalePercentage = Math.max(scale / 100.0, 0.01);
  const scaledWidth = Math.floor(scalePercentage * IMAGE_WIDTH);

  // Resize the image.
  const resizedImgPath = `${imgPath}--resized.png`;
  pic = pic.resize(scaledWidth, Jimp.AUTO);

  // Read the transparent background image.
  let transparentBackground = await Jimp.read("./transparent-square.png");
  transparentBackground = transparentBackground.resize(
    IMAGE_WIDTH,
    pic.bitmap.height
  );

  // Calculate offset and composite image.
  const x = IMAGE_WIDTH - pic.bitmap.width;
  const composedPic = transparentBackground.composite(pic, x, 0);

  // Save the composed image.
  await composedPic.writeAsync(resizedImgPath);

  // Convert the composed image to a dithered image and write directly to outputPath.
  return new Promise((resolve, reject) => {
    createReadStream(resizedImgPath)
      .pipe(new PNG())
      .on("parsed", function () {
        // 'this' is the PNG image object.
        dither(this, ALGORITHMS[algorithmChoice]);
        this.pack()
          .pipe(createWriteStream(outputPath))
          .on("finish", () => resolve(outputPath))
          .on("error", reject);
      })
      .on("error", reject);
  });
}

// ----- NEW HELPER FUNCTION -----
async function sendDensityControlPacket(characteristic, density) {
  // Build the packet using a minimal header and command sequence.
  // The density control byte is placed at offset 22.
  const packet = [
    0x02, 0x08, 0x00, 0x1a,
    0x00, 0x16, 0x00, 0x41,
    0x00, 0x0b, 0xff, 0x23,
    0x01, 0x1b, 0x40, 0x1f,
    0x11, 0x02, 0x04, 0x1f,
    0x11, 0x37, density, 0x1f,
    0x11, 0x0b, 0x1f, 0x11,
    0x35, 0x00, 0x86
  ];
  // Write the packet to the printer.
  characteristic.write(Buffer.from(packet), true);
  console.log(
    `Density control packet sent with density: 0x${density.toString(16)}`
  );
}
