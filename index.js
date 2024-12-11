const express = require('express');
const mysql = require('mysql2');
const dotenv = require('dotenv');
const cors = require('cors');
const moment = require('moment'); // Add moment for date formatting
const adminRoutes = require('./routes/adminRoutes');
const travelerRoutes = require('./routes/travelerRoutes');
const stops = require('./routes/stops');
const { SerialPort } = require('serialport');
const { ReadlineParser } = require('@serialport/parser-readline');

// Load environment variables from .env file
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Create MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  connectionLimit: 10
});

// Test the database connection
pool.getConnection((err, connection) => {
  if (err) {
    console.error('Database connection failed: ' + err.stack);
    return;
  }
  console.log('Connected to MySQL database as ID ' + connection.threadId);
  connection.release();
});

// Middleware to parse JSON bodies
app.use(express.json());

// CORS setup
app.use(cors({
  origin: 'http://localhost:3000', // Replace with your frontend origin
  credentials: true
}));

// Serial port setup for RFID communication
try {
  const port = new SerialPort({ path: 'COM3', baudRate: 9600 });
  const parser = port.pipe(new ReadlineParser({ delimiter: '\r\n' }));

  // Variables to manage trip states for multiple travelers
  const currentTrips = {}; // Object to store ongoing trip details keyed by RFID card number

  // Handle incoming RFID data
  parser.on('data', async (rfidData) => {
    try {
      const cardNumber = rfidData.trim(); // RFID card number received from Arduino

      // Fetch traveler details using RFID card number
      const query = `SELECT * FROM RFID_Cards WHERE card_number = '${cardNumber}'`;
      const [rows] = await pool.promise().query(query);
      const rfidCard = rows[0];

      if (!rfidCard) {
        console.log('Traveler not found for RFID:', cardNumber);
        return;
      }

      // Fetch wallet balance
      const balanceQuery = `SELECT balance FROM Wallet WHERE user_id = (SELECT user_id FROM RFID_Cards WHERE rfid_id = ?)`;
      const [balanceRows] = await pool.promise().query(balanceQuery, [rfidCard.rfid_id]);
      const wallet = balanceRows[0];

      if (wallet.balance <= 80) {
        console.log('Insufficient balance for RFID:', cardNumber);
        return;
      }

      if (!currentTrips[cardNumber]) {
        // First tap (boarding)
        console.log('Boarding detected:', rfidCard);

        // Record boarding details
        currentTrips[cardNumber] = {
          rfidId: rfidCard.rfid_id,
          cardNumber: rfidCard.card_number,
          boardingStopId: 1, // Replace with actual stop ID
          boardingTime: moment().format('YYYY-MM-DD HH:mm:ss') // Timestamp of boarding
        };

      } else {
        // Second tap (deboarding)
        console.log('Deboarding detected:', rfidCard);

        const trip = currentTrips[cardNumber];

        const deboardingStopId = 2; // Replace with actual stop ID
        const fare = await calculateFare(trip.boardingStopId, deboardingStopId);

        if (fare !== null) {
          // Update wallet balance (deduct fare)
          const updateWalletQuery = `UPDATE Wallet SET balance = balance - ? WHERE user_id = (SELECT user_id FROM RFID_Cards WHERE rfid_id = ?)`;
          await pool.promise().query(updateWalletQuery, [fare, trip.rfidId]);

          // Record trip details in database
          const tripInsertQuery = `INSERT INTO Trips (rfid_id, boarding_stop_id, deboarding_stop_id, boarding_time, deboarding_time, fare_amount)
                                   VALUES (?, ?, ?, ?, ?, ?)`;
          const deboardingTime = moment().format('YYYY-MM-DD HH:mm:ss');
          await pool.promise().query(tripInsertQuery, [trip.rfidId, trip.boardingStopId, deboardingStopId, trip.boardingTime, deboardingTime, fare]);

          console.log('Trip recorded successfully');
        } else {
          console.log('Fare not found for the given stops');
        }

        // Remove the completed trip from the currentTrips object
        delete currentTrips[cardNumber];
      }

    } catch (error) {
      console.error('Error handling RFID data:', error.message);
    }
  });

} catch (error) {
  console.error('Error setting up serial port:', error.message);
}

// Routes
app.use('/api/admin', adminRoutes);
app.use('/api/traveler', travelerRoutes);
app.use('/api/stops', stops);
// Handle 404 errors
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Server error' });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

// Function to calculate fare based on from_stop_id and to_stop_id
async function calculateFare(fromStopId, toStopId) {
  try {
    const query = `SELECT fare_amount FROM Fares WHERE from_stop_id = ? AND to_stop_id = ?`;
    const [rows] = await pool.promise().query(query, [fromStopId, toStopId]);
    if (rows.length > 0) {
      return rows[0].fare_amount;
    } else {
      return null;
    }
  } catch (error) {
    console.error('Error calculating fare:', error.message);
    return null;
  }
}
