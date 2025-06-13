const bcrypt = require('bcryptjs');
const pool = require('../../config/db');
const emailService = require('../../services/emailService');
const {
  createPasswordResetToken,
  validatePasswordResetToken,
  markPasswordResetAsUsed,
  checkRecentPasswordResetAttempts
} = require('../../models/auth/passwordResetModel');

// Request password reset
const requestPasswordReset = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        message: 'Email diperlukan'
      });
    }

    // Check if user exists
    const userQuery = `SELECT id, name, email, is_active FROM users WHERE email = $1`;
    const userResult = await pool.query(userQuery, [email]);
    
    if (userResult.rows.length === 0) {
      // Don't reveal if email exists or not for security
      return res.json({
        success: true,
        message: 'Jika email terdaftar, link reset password akan dikirim'
      });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.status(400).json({
        success: false,
        message: 'Akun tidak aktif'
      });
    }

    // Check rate limiting
    const recentAttempts = await checkRecentPasswordResetAttempts(email);
    if (!recentAttempts.canRequest) {
      return res.status(429).json({
        success: false,
        message: 'Terlalu banyak permintaan reset password. Coba lagi dalam 5 menit.'
      });
    }

    // Create reset token
    const resetData = await createPasswordResetToken(email);
    
    // Generate reset link
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetLink = `${frontendUrl}/reset-password?token=${resetData.token}`;

    // Send email
    const emailTemplate = emailService.generatePasswordResetEmail(
      user.name,
      resetLink,
      resetData.token
    );

    const emailResult = await emailService.sendEmail({
      to: email,
      subject: 'Reset Password - Futsal Booking System',
      html: emailTemplate.html,
      text: emailTemplate.text
    });

    if (!emailResult.success) {
      console.error('Failed to send password reset email:', emailResult.error);
      return res.status(500).json({
        success: false,
        message: 'Gagal mengirim email reset password'
      });
    }

    res.json({
      success: true,
      message: 'Link reset password telah dikirim ke email Anda',
      data: {
        email: email,
        expires_in: '1 hour'
      }
    });

  } catch (error) {
    console.error('Request password reset error:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal memproses permintaan reset password'
    });
  }
};

// Validate reset token
const validateResetToken = async (req, res) => {
  try {
    const { token } = req.params;

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token diperlukan'
      });
    }

    const validation = await validatePasswordResetToken(token);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    res.json({
      success: true,
      message: 'Token valid',
      data: {
        email: validation.data.email,
        user_name: validation.data.user_name,
        expires_at: validation.data.expires_at
      }
    });

  } catch (error) {
    console.error('Validate reset token error:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal memvalidasi token'
    });
  }
};

// Reset password
const resetPassword = async (req, res) => {
  try {
    const { token, new_password, confirm_password } = req.body;

    if (!token || !new_password || !confirm_password) {
      return res.status(400).json({
        success: false,
        message: 'Token, password baru, dan konfirmasi password diperlukan'
      });
    }

    if (new_password !== confirm_password) {
      return res.status(400).json({
        success: false,
        message: 'Password dan konfirmasi password tidak cocok'
      });
    }

    if (new_password.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password minimal 6 karakter'
      });
    }

    // Validate token
    const validation = await validatePasswordResetToken(token);

    if (!validation.valid) {
      return res.status(400).json({
        success: false,
        message: validation.error
      });
    }

    const { email, user_id } = validation.data;

    // Hash new password
    const saltRounds = 12;
    const hashedPassword = await bcrypt.hash(new_password, saltRounds);

    // Update user password
    const updateQuery = `
      UPDATE users 
      SET password = $1, updated_at = NOW()
      WHERE id = $2
      RETURNING id, email, name
    `;
    
    const updateResult = await pool.query(updateQuery, [hashedPassword, user_id]);

    if (updateResult.rows.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'User tidak ditemukan'
      });
    }

    // Mark token as used
    await markPasswordResetAsUsed(token);

    res.json({
      success: true,
      message: 'Password berhasil direset',
      data: {
        email: email,
        reset_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      success: false,
      message: 'Gagal mereset password'
    });
  }
};

module.exports = {
  requestPasswordReset,
  validateResetToken,
  resetPassword
};
